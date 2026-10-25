// The web app owns the engine process: spawn it, never twice, stop it when idle, bring it back, never touch one it didn't start.
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { EngineSupervisor, MIN_IDLE_MS } from "@/server/engine/supervisor";
import { POLL_READY_MS } from "@/lib/engineStatus";
import { emptyStatus, fromWarm, percent, statusLine, warmingFrom } from "@/lib/engineStatus";
import { describeApiError } from "@/lib/apiError";

class FakeChild extends EventEmitter {
  exitCode: number | null = null; killed = false; pid = 4242; stdout = new EventEmitter(); stderr = new EventEmitter();
  signals: string[] = [];
  kill(sig: string) { this.signals.push(sig); this.killed = true; this.exitCode = 0; this.emit("exit", 0, sig); return true; }
  die(code: number) { this.exitCode = code; this.emit("exit", code, null); }
}

function rig(env: Record<string, string | undefined> = {}) {
  const children: FakeChild[] = [];
  const spawn = vi.fn((_cmd: string, _args: string[], _opts: any) => { const c = new FakeChild(); children.push(c); return c as any; });
  const state = { healthy: false, warm: { state: "ready" } as any, now: 1_000_000 };
  const fetchFn = vi.fn(async (url: string) => {
    if (!state.healthy) throw new TypeError("fetch failed");
    return { ok: true, json: async () => ({ status: "ok", warm: state.warm }) } as any;
  });
  const sup = new EngineSupervisor({
    spawn: spawn as any, fetch: fetchFn as any, now: () => state.now, startTimer: false,
    exists: () => true, env: { ENGINE_DIR: "/srv/engine-repo", ENGINE_IDLE_MINUTES: "10", ...env } as unknown as NodeJS.ProcessEnv,
  });
  return { sup, spawn, children, state, fetchFn };
}

describe("EngineSupervisor", () => {
  it("spawns the engine once, however many callers ask at the same time", async () => {
    const { sup, spawn } = rig();
    await Promise.all([sup.ensureEngine(), sup.ensureEngine(), sup.ensureEngine()]);
    await sup.ensureEngine();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("starts uvicorn in the engine folder with the app's PID so the engine can exit when the app dies", async () => {
    const { sup, spawn } = rig({ ENGINE_BASE_URL: "http://127.0.0.1:8123" });
    await sup.ensureEngine();
    const [cmd, args, opts] = spawn.mock.calls[0];
    expect(cmd).toMatch(/uvicorn$/);
    expect(args).toEqual(["--factory", "engine.app:create_app", "--host", "127.0.0.1", "--port", "8123"]);
    expect(opts.cwd).toBe("/srv/engine-repo");
    expect(opts.env.ENGINE_PARENT_PID).toBe(String(process.pid));
  });

  it("adopts an engine that is already answering, and never kills it", async () => {
    const { sup, spawn, state } = rig();
    state.healthy = true;
    await sup.ensureEngine();
    expect(spawn).not.toHaveBeenCalled();
    state.now += 60 * 60_000;
    await sup.tick();   // an hour idle: still not ours to stop
    expect((await sup.status()).state).toBe("ready");
  });

  it("ENGINE_MANAGED=0 never spawns or stops anything, but still reports the engine's state", async () => {
    const { sup, spawn, state } = rig({ ENGINE_MANAGED: "0" });
    await sup.ensureEngine();
    sup.beat();
    expect(spawn).not.toHaveBeenCalled();
    expect((await sup.status())).toMatchObject({ state: "stopped", managed: false });
    state.healthy = true; state.warm = { state: "warming", phase: "shares", done: 5, total: 10 };
    expect((await sup.status())).toMatchObject({ state: "warming", phase: "shares", managed: false });
  });

  it("never spawns on Netlify, even if ENGINE_MANAGED was forgotten (functions cannot run a child process)", async () => {
    const { sup, spawn } = rig({ NETLIFY: "true" });
    await sup.ensureEngine();
    sup.beat();
    expect(spawn).not.toHaveBeenCalled();
    expect(sup.managed).toBe(false);
    expect(await sup.status()).toMatchObject({ state: "stopped", managed: false });
  });

  it("starts no idle timer for an engine it does not own", () => {
    const set = vi.spyOn(globalThis, "setInterval");
    try {
      new EngineSupervisor({ env: { ENGINE_MANAGED: "0" } as unknown as NodeJS.ProcessEnv, fetch: vi.fn() as any });
      new EngineSupervisor({ env: { NETLIFY: "true" } as unknown as NodeJS.ProcessEnv, fetch: vi.fn() as any });
      expect(set).not.toHaveBeenCalled();
    } finally { set.mockRestore(); }
  });

  it("sends the engine token on the warm-up retry it makes itself", async () => {
    const { sup, state, fetchFn } = rig({ ENGINE_MANAGED: "0", ENGINE_TOKEN: "s3cret" });
    state.healthy = true;
    await sup.retry();
    const retryCall = fetchFn.mock.calls.find(([url]) => String(url).endsWith("/warmup/retry"))!;
    expect(new Headers((retryCall[1] as any).headers).get("authorization")).toBe("Bearer s3cret");
  });

  it("stops the engine after the idle window with no tab, and the next tab brings it back", async () => {
    const { sup, spawn, children, state } = rig();
    await sup.ensureEngine();
    state.now += 9 * 60_000;
    await sup.tick();
    expect(children[0].signals).toEqual([]);          // a refresh or short absence inside the window changes nothing
    sup.beat();                                       // a tab is still around
    state.now += 9 * 60_000;
    await sup.tick();
    expect(children[0].signals).toEqual([]);
    state.now += 2 * 60_000;                          // now 11 minutes since the last beat
    await sup.tick();
    expect(children[0].signals).toEqual(["SIGTERM"]);
    expect((await sup.status()).state).toBe("stopped");   // stopped on purpose: not an error
    sup.beat();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
  });

  it("never treats a tab that is between two polls as gone, however short the configured idle time", async () => {
    const { sup, children, state } = rig({ ENGINE_IDLE_MINUTES: "0.05" });   // 3 seconds asked for
    expect(sup.idleMs).toBe(MIN_IDLE_MS);
    expect(MIN_IDLE_MS).toBeGreaterThan(POLL_READY_MS * 2);
    await sup.ensureEngine();
    sup.beat();
    state.now += POLL_READY_MS + 1_000;      // the next poll is due, just not here yet
    await sup.tick();
    expect(children[0].signals).toEqual([]);
    state.now += MIN_IDLE_MS;                // genuinely gone
    await sup.tick();
    expect(children[0].signals).toEqual(["SIGTERM"]);
  });

  it("reports an engine that died on its own as an error with its last output, and retry starts a new one", async () => {
    const { sup, spawn, children } = rig();
    await sup.ensureEngine();
    children[0].stderr.emit("data", Buffer.from("Traceback...\nOSError: Unexpected end of stream\n"));
    children[0].die(1);
    const s = await sup.status();
    expect(s.state).toBe("error");
    expect(s.error).toMatch(/stopped unexpectedly/);
    expect(s.log?.join("\n")).toMatch(/Unexpected end of stream/);
    await sup.retry();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect((await sup.status()).state).toBe("starting");
  });

  it("says what is wrong when the engine code cannot be found", async () => {
    const { sup, spawn } = rig({ ENGINE_DIR: "/nowhere" });
    const noFiles = new EngineSupervisor({ spawn: spawn as any, fetch: (async () => { throw new TypeError("fetch failed"); }) as any, exists: () => false, startTimer: false, env: { ENGINE_DIR: "/nowhere" } as unknown as NodeJS.ProcessEnv });
    await noFiles.ensureEngine();
    expect(spawn).not.toHaveBeenCalled();
    expect(await noFiles.status()).toMatchObject({ state: "error", error: expect.stringMatching(/ENGINE_DIR/) });
    void sup;
  });

  it("retry on a live engine that failed to load asks it to reload", async () => {
    const { sup, state, fetchFn } = rig();
    state.healthy = true; state.warm = { state: "error", error: "OSError: boom", retryable: true };
    await sup.retry();
    expect(fetchFn.mock.calls.some(([u, o]: any) => String(u).endsWith("/warmup/retry") && o?.method === "POST")).toBe(true);
  });
});

describe("engine status helpers", () => {
  it("reads the engine's warm snapshot, and a 503 body in either shape", () => {
    const warm = { state: "warming", phase: "shares", phase_index: 2, done: 100, total: 2300, elapsed_s: 75, phase_elapsed_s: 12, retryable: false };
    expect(fromWarm(warm, true)).toMatchObject({ state: "warming", phase: "shares", phaseIndex: 2, done: 100, total: 2300, elapsedS: 75 });
    expect(warmingFrom({ detail: { engine: warm } })?.state).toBe("warming");
    expect(warmingFrom({ engine: warm })?.state).toBe("warming");
    expect(warmingFrom({ detail: [{ message: "x" }] })).toBeNull();
    expect(warmingFrom("Internal Server Error")).toBeNull();
  });

  it("only shows a percentage when the engine knows a real count", () => {
    expect(percent({ done: 100, total: 2300 })).toBe(4);
    expect(percent({ done: null, total: null })).toBeNull();
    expect(percent({ done: 0, total: 0 })).toBeNull();
  });

  it("describes each state in plain words and never leaks a raw 503 as an error", () => {
    expect(statusLine(emptyStatus("ready"))).toBe("Data engine ready");
    expect(statusLine(emptyStatus("warming", true, { phase: "weekly_prices" }))).toBe("Loading market data · Weekly prices");
    expect(describeApiError({ detail: { engine: { state: "warming" } } }, "x")).toMatch(/still loading market data/);
    expect(describeApiError({ detail: [{ condition_id: "C1", message: "bad" }] }, "x")).toBe("C1: bad");
  });
});
