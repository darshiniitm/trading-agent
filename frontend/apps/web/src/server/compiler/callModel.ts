export const DEFAULT_COMPILER_MODEL = process.env.OLLAMA_COMPILER_MODEL ?? process.env.OLLAMA_MODEL ?? "mistral:latest";
export const DEFAULT_OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";

type OllamaChunk = { message?: { content?: string }; error?: string; done?: boolean };

// ---- per-task profiles -------------------------------------------------------------------------------
// gemma-class models think by default, which costs ~4x the generation time. Thinking is decided per task: off where
// the model only copies values into a closed schema that is re-verified afterwards (fallback), on where it must
// reason (cross-line linking, conversions, judging a reading). `num_predict` bounds every call; thinking tokens count
// against it, so the thinking profiles get more room. Override one task with OLLAMA_THINK_<TASK>=0|1.
export type TaskName = "fallback" | "modelRead" | "reader" | "critic" | "curate";
export type CallOpts = { task?: TaskName };
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
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX ?? 8192);
// models that rejected `think` once: do not send it to them again
const noThink = new Set<string>();

// `format` is a JSON Schema: Ollama constrains decoding to it (structured outputs), so a
// missing key can't happen. Without one it falls back to plain valid-JSON mode.
export async function callOllama(system: string, user: string, format?: object, fetchFn: typeof fetch = fetch, model: string = DEFAULT_COMPILER_MODEL, opts: CallOpts = {}): Promise<string> {
  const profile = profileFor(opts.task);
  let response: Response;
  try {
    response = await fetchFn(`${DEFAULT_OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: true,   // streamed so response headers arrive at once: a non-streaming call to a large local model trips Node's 300s header timeout
        format: format ?? "json",
        keep_alive: KEEP_ALIVE,
        options: { temperature: 0, num_ctx: NUM_CTX, ...(profile ? { num_predict: profile.num_predict } : {}) },
        ...(profile && !noThink.has(model) ? { think: profile.think } : {}),
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
    });
  } catch (error) {
    throw new Error(`Ollama is not reachable at ${DEFAULT_OLLAMA_BASE_URL}. Start Ollama and pull ${model}: ${(error as Error).message}`);
  }

  if (!response.ok) {
    const err = (await response.json().catch(() => ({}))) as OllamaChunk;
    // a model without a thinking mode (e.g. mistral) rejects `think`: remember it and ask again without
    if (profile && !noThink.has(model) && /think/i.test(err.error ?? "")) { noThink.add(model); return callOllama(system, user, format, fetchFn, model, opts); }
    throw new Error(`Ollama compiler request failed (${response.status}): ${err.error ?? "unknown error"}`);
  }
  // NDJSON: one chunk per line, each carrying a slice of message.content.
  let content = "";
  const eat = (line: string) => {
    if (!line.trim()) return;
    const chunk = JSON.parse(line) as OllamaChunk;
    if (chunk.error) throw new Error(`Ollama compiler request failed (${response.status}): ${chunk.error}`);
    content += chunk.message?.content ?? "";
  };
  const decoder = new TextDecoder();
  let pending = "";
  const reader = response.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop()!;
    lines.forEach(eat);
  }
  eat(pending + decoder.decode());
  if (!content) throw new Error("Ollama compiler returned no text content");
  return content;
}

// Keep the existing compiler seam name so the rest of the app and injected test
// call models remain unchanged. It now delegates exclusively to local Ollama.
export const callClaude = (system: string, user: string, format?: object, opts?: CallOpts): Promise<string> =>
  callOllama(system, user, format, fetch, DEFAULT_COMPILER_MODEL, opts);

// A call model bound to a specific local model (used by the compiler-model evaluation).
export const ollamaFor = (model: string) => (system: string, user: string, format?: object, opts?: CallOpts) => callOllama(system, user, format, fetch, model, opts);

// Load the model into memory (and hold it for KEEP_ALIVE) before the first user prompt: a cold start is ~9s of load
// plus ~25s of prefill. Best effort: never throws, a missing Ollama is reported on the first real call.
export async function warmModel(model: string = DEFAULT_COMPILER_MODEL, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await fetchFn(`${DEFAULT_OLLAMA_BASE_URL}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, messages: [], stream: false, keep_alive: KEEP_ALIVE, options: { num_ctx: NUM_CTX } }) });
    return r.ok;
  } catch { return false; }
}
