// What the screening engine is doing, in the shape the app shows. Shared by the server (supervisor, routes) and the browser
// (hook, pill, buffer panel). The engine reports its own warm-up (engine/warmup.py); the supervisor adds "stopped"/"starting".

// How often an open tab asks for the engine's state (each ask is also its heartbeat). Shared so the server's idle floor can
// never fall below it: an engine must not be stopped under a tab that is simply between two polls.
export const POLL_BUSY_MS = 1_500;
export const POLL_READY_MS = 15_000;

export type EngineState = "stopped" | "starting" | "warming" | "ready" | "error";

export type EngineStatus = {
  state: EngineState;
  phase: string | null;            // universe | weekly_prices | shares | daily_bars | reference_data
  phaseIndex: number | null;
  phases: string[];
  done: number | null;             // only when the engine knows a real count for the phase
  total: number | null;
  elapsedS: number;
  phaseElapsedS: number;
  error: string | null;
  retryable: boolean;
  managed: boolean;                // the web app owns the engine process (ENGINE_MANAGED != 0)
  log?: string[];                  // last engine output, only sent when state is "error"
};

export const PHASES = ["universe", "weekly_prices", "shares", "daily_bars", "reference_data", "indexes"] as const;

export const PHASE_LABEL: Record<string, string> = {
  universe: "Stock universe",
  weekly_prices: "Weekly prices",
  shares: "Shares outstanding",
  daily_bars: "Daily prices",
  reference_data: "Reference data",
  indexes: "Building indexes",
};

export const emptyStatus = (state: EngineState, managed = true, over: Partial<EngineStatus> = {}): EngineStatus => ({
  state, phase: null, phaseIndex: null, phases: [...PHASES], done: null, total: null, elapsedS: 0, phaseElapsedS: 0,
  error: null, retryable: state === "error", managed, ...over,
});

// The engine's snapshot (snake_case, engine/warmup.py:WarmState.snapshot) -> EngineStatus.
export function fromWarm(w: any, managed: boolean): EngineStatus {
  const state: EngineState = w?.state === "ready" ? "ready" : w?.state === "error" ? "error" : w?.state === "warming" ? "warming" : "starting";
  return emptyStatus(state, managed, {
    phase: w?.phase ?? null, phaseIndex: typeof w?.phase_index === "number" ? w.phase_index : null,
    phases: Array.isArray(w?.phases) ? w.phases : [...PHASES],
    done: typeof w?.done === "number" ? w.done : null, total: typeof w?.total === "number" ? w.total : null,
    elapsedS: Number(w?.elapsed_s ?? 0), phaseElapsedS: Number(w?.phase_elapsed_s ?? 0),
    error: w?.error ?? null, retryable: !!w?.retryable,
  });
}

// A 503 from the engine while it loads: {"detail": {"engine": <snapshot>}} (FastAPI HTTPException). Our own routes pass it through.
export function warmingFrom(body: unknown): EngineStatus | null {
  const eng = (body as any)?.detail?.engine ?? (body as any)?.engine;
  return eng && typeof eng === "object" ? fromWarm(eng, true) : null;
}

export const isWarmingBody = (body: unknown): boolean => warmingFrom(body) !== null;

// A real percentage only when the engine gave a count; otherwise null (the UI shows an indeterminate bar, never a made-up number).
export const percent = (s: Pick<EngineStatus, "done" | "total">): number | null =>
  s.total && s.total > 0 && s.done !== null ? Math.max(0, Math.min(100, Math.round((s.done / s.total) * 100))) : null;

export const formatElapsed = (s: number): string => {
  const n = Math.max(0, Math.round(s));
  return n < 60 ? `${n}s` : `${Math.floor(n / 60)}m ${String(n % 60).padStart(2, "0")}s`;
};

// One plain sentence for the header pill / status text.
export function statusLine(s: EngineStatus): string {
  switch (s.state) {
    case "ready": return "Data engine ready";
    case "stopped": return "Data engine is not running";
    case "starting": return "Starting the data engine";
    case "warming": return `Loading market data${s.phase ? ` · ${PHASE_LABEL[s.phase] ?? s.phase}` : ""}`;
    case "error": return "Data engine problem";
  }
}
