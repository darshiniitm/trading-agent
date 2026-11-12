// LLM provider config. Read from env at call time (not import time) so tests and the A4 parity run can switch provider.
//   LLM_PROVIDER=local  -> local Ollama, no auth, streamed, no timeout/retry/fallback (exactly the pre-cloud behaviour)
//   LLM_PROVIDER=cloud  -> Ollama Cloud (https://ollama.com), Bearer key, hard timeout, one retry, fallback chain
export type Provider = "local" | "cloud";
export type LlmConfig = {
  provider: Provider;
  host: string;
  apiKey?: string;
  fallbackModels: string[];
  timeoutMs: number;
  maxRetries: number;
  timeoutFor: (task?: string) => number;
};

const num = (v: string | undefined, d: number) => { const n = Number(v); return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : d; };

export function loadLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const raw = (env.LLM_PROVIDER ?? "local").trim().toLowerCase();
  if (raw !== "local" && raw !== "cloud") throw new Error(`LLM_PROVIDER must be "local" or "cloud" (got "${env.LLM_PROVIDER}")`);
  const provider: Provider = raw;
  const apiKey = env.OLLAMA_API_KEY?.trim() || undefined;
  if (provider === "cloud" && !apiKey) throw new Error("LLM_PROVIDER=cloud needs OLLAMA_API_KEY (create one at ollama.com/settings/keys)");
  const host = (env.OLLAMA_HOST ?? (provider === "cloud" ? "https://ollama.com" : env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434")).replace(/\/+$/, "");
  const timeoutMs = num(env.LLM_TIMEOUT_MS, 8000);
  return {
    provider,
    host,
    // a key is only ever attached for the cloud provider, so a stray local key is never sent to a local/other host
    apiKey: provider === "cloud" ? apiKey : undefined,
    fallbackModels: provider === "cloud" ? (env.OLLAMA_FALLBACK_MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean) : [],
    timeoutMs,
    maxRetries: Math.floor(num(env.LLM_MAX_RETRIES, 1)),
    // thinking tasks can legitimately outlast the default: LLM_TIMEOUT_MS_<TASK> overrides one task
    timeoutFor: (task) => (task ? num(env[`LLM_TIMEOUT_MS_${task.toUpperCase()}`], timeoutMs) : timeoutMs),
  };
}
