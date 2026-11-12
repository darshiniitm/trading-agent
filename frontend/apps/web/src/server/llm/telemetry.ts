// Telemetry seam for every LLM call. Part A ships only the interface and a no-op default; Part B (observability) installs
// a real sink with setLlmTelemetry(). A sink that throws must never fail a call — the client guards every emit.
export type CallStatus = "ok" | "429" | "5xx" | "timeout" | "bad_json" | "network" | "auth" | "client_error";

// Ollama's own timing fields; durations are nanoseconds.
export type OllamaTiming = { total_duration?: number; load_duration?: number; prompt_eval_count?: number; eval_count?: number; eval_duration?: number };

export type LlmCallEvent = {
  provider: "local" | "cloud";
  model: string;
  task?: string;
  status: CallStatus;
  httpStatus?: number;
  latencyMs: number;
  attempt: number;          // 0 = first try on this model
  timing?: OllamaTiming;
};

export interface LlmTelemetry {
  call(e: LlmCallEvent): void;
  retry(e: { model: string; status: CallStatus; attempt: number }): void;
  fallback(e: { from_model: string; to_model: string }): void;
}

export const noopTelemetry: LlmTelemetry = { call() {}, retry() {}, fallback() {} };

// Held on globalThis: Next re-evaluates modules in dev and bundles instrumentation.ts separately from route handlers
// (compare src/server/engine/supervisor.ts), so a module-level `let` would install the sink into a copy that calls never read.
const KEY = Symbol.for("trading.llm.telemetry");
const holder = globalThis as unknown as Record<symbol, LlmTelemetry | undefined>;
export const setLlmTelemetry = (t: LlmTelemetry | null) => { holder[KEY] = t ?? undefined; };
export const getLlmTelemetry = (): LlmTelemetry => holder[KEY] ?? noopTelemetry;
