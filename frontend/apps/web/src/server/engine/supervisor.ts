// Owns the screening engine's process so it lives and dies with the web app (decided: managed by default,
// ENGINE_MANAGED=0 to run the engine yourself; stop it after the last browser tab has been gone for ENGINE_IDLE_MINUTES).
//
//   start    the web server boots (instrumentation.ts) or a tab asks -> spawn `uvicorn engine.app:create_app` as a child
//   guard    the child gets ENGINE_PARENT_PID, so even a SIGKILL of this process cannot leave an orphan (engine/watchdog.py)
//   idle     tabs heartbeat via /api/engine/status; none for ENGINE_IDLE_MINUTES -> SIGTERM the engine, a later tab respawns it
//   adopt    an engine already answering on the port (started by hand) is used, never spawned over and never killed
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { POLL_READY_MS, emptyStatus, fromWarm, type EngineStatus } from "@/lib/engineStatus";

// Never stop an engine sooner than three of the slowest polls: a tab that is merely between two heartbeats is still there.
export const MIN_IDLE_MS = POLL_READY_MS * 3;

export type SupervisorDeps = {
  spawn: typeof nodeSpawn;
  fetch: typeof fetch;
  now: () => number;
  env: NodeJS.ProcessEnv;
  exists: (p: string) => boolean;
  startTimer: boolean;
};

const LOG_LINES = 200;

export class EngineSupervisor {
  private d: SupervisorDeps;
  private child: ChildProcess | null = null;
  private adopted = false;
  private log: string[] = [];
  private lastBeat: number;
  private spawnError: string | null = null;
  private stoppedForIdle = false;
  private starting: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: Partial<SupervisorDeps> = {}) {
    this.d = { spawn: nodeSpawn, fetch, now: Date.now, env: process.env, exists: existsSync, startTimer: true, ...deps };
    this.lastBeat = this.d.now();
    if (this.d.startTimer) {
      this.timer = setInterval(() => void this.tick(), Math.min(15_000, Math.max(250, this.idleMs / 4)));
      this.timer.unref?.();
    }
  }

  // ---- configuration --------------------------------------------------------------------------------------------------
  get managed(): boolean { return this.d.env.ENGINE_MANAGED !== "0"; }
  get idleMs(): number { return Math.max(MIN_IDLE_MS, Number(this.d.env.ENGINE_IDLE_MINUTES ?? 10) * 60_000); }
  get baseUrl(): string { return this.d.env.ENGINE_BASE_URL ?? "http://127.0.0.1:8001"; }
  private get port(): string { try { return new URL(this.baseUrl).port || "8001"; } catch { return "8001"; } }

  /** Where the engine's code lives: ENGINE_DIR, else the first parent of the working directory that has engine/app.py. */
  engineDir(): string | null {
    const set = this.d.env.ENGINE_DIR;
    if (set) return this.d.exists(path.join(set, "engine", "app.py")) ? set : null;
    for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
      if (this.d.exists(path.join(dir, "engine", "app.py"))) return dir;
      if (path.dirname(dir) === dir) return null;
    }
  }

  // ---- state ------------------------------------------------------------------------------------------------------------
  private alive(): boolean { return !!this.child && this.child.exitCode === null && !this.child.killed; }

  private async probe(): Promise<any | null> {
    try {
      const res = await this.d.fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
      return res.ok ? await res.json() : null;
    } catch { return null; }
  }

  async status(): Promise<EngineStatus> {
    const h = await this.probe();
    if (h) return fromWarm(h.warm ?? { state: "ready" }, this.managed);
    if (this.spawnError) return emptyStatus("error", this.managed, { error: this.spawnError, retryable: true, log: this.log.slice(-40) });
    if (this.alive()) return emptyStatus("starting", this.managed);
    return emptyStatus("stopped", this.managed);
  }

  // ---- lifecycle --------------------------------------------------------------------------------------------------------
  /** Make sure an engine is running (or on its way). No-op when unmanaged or one is already there. */
  ensureEngine(): Promise<void> {
    if (!this.managed) return Promise.resolve();
    this.starting ??= this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async start(): Promise<void> {
    if (this.alive()) return;
    if (await this.probe()) { this.adopted = true; return; }   // someone else's engine: use it, never kill it
    this.adopted = false;
    const dir = this.engineDir();
    if (!dir) {
      this.spawnError = "The engine code was not found. Set ENGINE_DIR to the folder that contains engine/app.py (or ENGINE_MANAGED=0 and start the engine yourself).";
      return;
    }
    this.spawnError = null; this.stoppedForIdle = false; this.lastBeat = this.d.now();
    const venv = path.join(dir, ".venv", "bin", "uvicorn");
    const cmd = this.d.exists(venv) ? venv : "uvicorn";
    const child = this.d.spawn(cmd, ["--factory", "engine.app:create_app", "--host", "127.0.0.1", "--port", this.port], {
      cwd: dir, stdio: ["ignore", "pipe", "pipe"],
      env: { ...this.d.env, ENGINE_PARENT_PID: String(process.pid), PYTHONUNBUFFERED: "1" },
    });
    this.child = child;
    const sink = (b: Buffer) => { this.log.push(...b.toString().split("\n").filter(Boolean)); if (this.log.length > LOG_LINES) this.log.splice(0, this.log.length - LOG_LINES); };
    child.stdout?.on("data", sink); child.stderr?.on("data", sink);
    child.on("error", (e) => { this.spawnError = `Could not start the engine: ${e.message}`; this.child = null; });
    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      if (!this.stoppedForIdle && code !== 0 && signal !== "SIGTERM") this.spawnError = `The engine stopped unexpectedly (${signal ?? `exit code ${code}`}).`;
    });
  }

  /** A browser tab is looking at the app. Brings the engine back if it was stopped for being idle. */
  beat(): void {
    this.lastBeat = this.d.now();
    if (this.managed && !this.alive() && !this.spawnError) void this.ensureEngine();
  }

  /** Restart after an error: ask a live engine to reload, or spawn a fresh one. */
  async retry(): Promise<void> {
    if (await this.probe()) {
      try { await this.d.fetch(`${this.baseUrl}/warmup/retry`, { method: "POST", signal: AbortSignal.timeout(3000) }); } catch { /* status shows it */ }
      return;
    }
    this.spawnError = null;
    await this.ensureEngine();
  }

  /** Called on a timer: stop an engine that has had no tab for the idle window. */
  async tick(): Promise<void> {
    if (!this.managed || !this.alive() || this.adopted) return;
    if (this.d.now() - this.lastBeat > this.idleMs) this.stop("idle");
  }

  stop(reason: "idle" | "shutdown" = "shutdown"): void {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    this.stoppedForIdle = reason === "idle";
    child.kill("SIGTERM");
    const hard = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 5000);
    hard.unref?.();
  }

  recentLog(n = 40): string[] { return this.log.slice(-n); }
  dispose(): void { if (this.timer) clearInterval(this.timer); this.stop("shutdown"); }
}

// One supervisor per server process. Next dev re-evaluates modules on every edit, so it lives on globalThis:
// a hot reload must never start a second engine.
const KEY = Symbol.for("screener.engine.supervisor");
export function getSupervisor(): EngineSupervisor {
  const g = globalThis as unknown as Record<symbol, EngineSupervisor | undefined>;
  if (!g[KEY]) {
    const s = new EngineSupervisor();
    g[KEY] = s;
    process.once("exit", () => s.dispose());
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.once(sig, () => { s.dispose(); if (process.listenerCount(sig) === 0) process.exit(0); });   // our listener replaced the default exit
    }
  }
  return g[KEY]!;
}
