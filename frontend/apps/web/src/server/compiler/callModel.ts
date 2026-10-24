import { chat } from "@/server/llm/client";
import { loadLlmConfig } from "@/server/llm/config";

export const DEFAULT_COMPILER_MODEL = process.env.OLLAMA_COMPILER_MODEL ?? process.env.OLLAMA_MODEL ?? "mistral:latest";
export const DEFAULT_OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";

// ---- per-task profiles -------------------------------------------------------------------------------
// gemma-class models think by default, which costs ~4x the generation time. Thinking is decided per task: off where
// the model only copies values into a closed schema that is re-verified afterwards (fallback), on where it must
// reason (cross-line linking, conversions, judging a reading). `num_predict` bounds every call; thinking tokens count
// against it, so the thinking profiles get more room. Override one task with OLLAMA_THINK_<TASK>=0|1.
export type TaskName = "fallback" | "modelRead" | "reader" | "critic" | "curate";
// fallback: may the cloud fallback chain (OLLAMA_FALLBACK_MODELS) answer if the model fails? Pinned-model evals pass false.
export type CallOpts = { task?: TaskName; fallback?: boolean };
export type TaskProfile = { think: boolean; num_predict: number };
export const TASK_PROFILES: Record<TaskName, TaskProfile> = {
  fallback: { think: false, num_predict: 768 },
  modelRead: { think: true, num_predict: 3072 },
  reader: { think: false, num_predict: 1536 },   // A/B on gemma4:31b: 6/6 either way, 27s vs 96s per case; its output is span-verified
  critic: { think: true, num_predict: 2048 },
  curate: { think: true, num_predict: 3072 },
};
export const profileFor = (task?: TaskName, env: NodeJS.ProcessEnv = process.env): TaskProfile | undefined => {
  if (!task) return undefined;
  const base = TASK_PROFILES[task], o = env[`OLLAMA_THINK_${task.toUpperCase()}`];
  return o === "0" || o === "1" ? { ...base, think: o === "1" } : base;
};
export const KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE ?? "30m";
// Largest prompt (the Reader's) is ~2k tokens; a fixed window also stops Ollama reloading the model when num_ctx changes between calls.
// (Local only: Ollama Cloud manages its own context and keep-alive.)
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX ?? 8192);

// `format` is a JSON Schema: Ollama constrains decoding to it (structured outputs), so a
// missing key can't happen. Without one it falls back to plain valid-JSON mode.
// The HTTP work (local vs Ollama Cloud, auth, timeout, retry, fallback, telemetry) lives in src/server/llm/client.ts.
export const callOllama = (system: string, user: string, format?: object, fetchFn: typeof fetch = fetch, model: string = DEFAULT_COMPILER_MODEL, opts: CallOpts = {}): Promise<string> =>
  chat({ system, user, format, model, task: opts.task, profile: profileFor(opts.task), fallback: opts.fallback }, { fetchFn });

// Keep the existing compiler seam name so the rest of the app and injected test
// call models remain unchanged. Local or Ollama Cloud is chosen by LLM_PROVIDER (see src/server/llm/config.ts).
export const callClaude = (system: string, user: string, format?: object, opts?: CallOpts): Promise<string> =>
  callOllama(system, user, format, fetch, DEFAULT_COMPILER_MODEL, { fallback: true, ...opts });

// A call model bound to a specific local model (used by the compiler-model evaluation).
export const ollamaFor = (model: string) => (system: string, user: string, format?: object, opts?: CallOpts) => callOllama(system, user, format, fetch, model, { ...opts, fallback: false });

// Load the model into memory (and hold it for KEEP_ALIVE) before the first user prompt: a cold start is ~9s of load
// plus ~25s of prefill. Best effort: never throws, a missing Ollama is reported on the first real call.
export async function warmModel(model: string = DEFAULT_COMPILER_MODEL, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const cfg = loadLlmConfig();
    if (cfg.provider === "cloud") return true;   // hosted models are always warm; the startup check (checkModelAvailable) covers reachability
    const r = await fetchFn(`${cfg.host}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, messages: [], stream: false, keep_alive: KEEP_ALIVE, options: { num_ctx: NUM_CTX } }) });
    return r.ok;
  } catch { return false; }
}
