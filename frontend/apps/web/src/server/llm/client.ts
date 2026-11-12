// The single LLM client. Everything that talks to Ollama (local or cloud) goes through chat(); callModel.ts is a thin seam over it.
// Cloud adds: Bearer auth, hard timeout, one jittered retry on 429/5xx/timeout/network, an ordered model fallback chain,
// one JSON-repair attempt, key redaction and telemetry. Local keeps its original streamed, no-retry behaviour.
import { loadLlmConfig, type LlmConfig } from "./config";
import { getLlmTelemetry, type CallStatus, type LlmCallEvent, type LlmTelemetry, type OllamaTiming } from "./telemetry";

export type ChatProfile = { think: boolean; num_predict: number };
export type ChatRequest = {
  system: string;
  user: string;
  model: string;
  format?: object;
  task?: string;
  profile?: ChatProfile;
  fallback?: boolean;       // may the fallback chain be used? false when a caller pinned a model (evals)
};
export type ChatDeps = {
  fetchFn?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
  telemetry?: LlmTelemetry;
};

// Local-only knobs (unchanged from before the cloud client).
const KEEP_ALIVE = () => process.env.OLLAMA_KEEP_ALIVE ?? "30m";
const NUM_CTX = () => Number(process.env.OLLAMA_NUM_CTX ?? 8192);
// models that rejected `think` once: do not send it to them again
const noThink = new Set<string>();

class LlmError extends Error {
  constructor(message: string, readonly status: CallStatus, readonly retryable: boolean, readonly httpStatus?: number) { super(message); }
}

export const redact = (text: string, env: NodeJS.ProcessEnv = process.env): string => {
  let out = text.replace(/(Bearer\s+)[^\s"',;]+/gi, "$1[redacted]");
  const key = env.OLLAMA_API_KEY?.trim();
  if (key) out = out.split(key).join("[redacted]");
  return out;
};

const classify = (httpStatus: number): { status: CallStatus; retryable: boolean } =>
  httpStatus === 429 ? { status: "429", retryable: true }
  : httpStatus >= 500 ? { status: "5xx", retryable: true }
  : httpStatus === 401 || httpStatus === 403 ? { status: "auth", retryable: false }
  : { status: "client_error", retryable: false };

const TIMING_KEYS = ["total_duration", "load_duration", "prompt_eval_count", "eval_count", "eval_duration"] as const;
const takeTiming = (chunk: Record<string, unknown>, into: OllamaTiming) => { for (const k of TIMING_KEYS) if (typeof chunk[k] === "number") into[k] = chunk[k] as number; };
const parses = (s: string) => { try { JSON.parse(s); return true; } catch { return false; } };
// Ollama Cloud does not hard-constrain decoding to `format` the way local does: replies can arrive wrapped in a ```json fence.
// Unwrapping is deterministic and lossless; anything that still does not parse goes to bad_json / one repair.
const unfence = (s: string): string => { const m = s.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i); return m ? m[1] : s; };

// Cloud only: tell the model the shape, since decoding is not constrained to it. Callers still deep-validate (zod) and have their own retries.
const withSchemaContract = (system: string, format?: object): string =>
  format ? `${system}\n\nOutput contract: respond with ONLY one JSON object (no markdown fences, no prose) that conforms exactly to this JSON Schema; use exactly these property names:\n${JSON.stringify(format)}` : system;
// Shallow structural check (top-level required keys); returns what is wrong, or null. Deep validation stays with the caller.
const shapeProblem = (content: string, format?: object): string | null => {
  let v: unknown;
  try { v = JSON.parse(content); } catch { return "it was not valid JSON"; }
  const required = (format as { required?: string[] } | undefined)?.required;
  if (!required?.length) return null;
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "it was not a JSON object";
  const missing = required.filter((k) => !(k in (v as object)));
  return missing.length ? `it was missing required properties: ${missing.join(", ")}` : null;
};

const authHeaders = (cfg: LlmConfig): Record<string, string> => ({ "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) });

// One HTTP call to one model. Throws LlmError. Resolves { content, timing }.
async function once(cfg: LlmConfig, req: ChatRequest, messages: { role: string; content: string }[], model: string, fetchFn: typeof fetch, env: NodeJS.ProcessEnv): Promise<{ content: string; timing: OllamaTiming; httpStatus: number }> {
  const cloud = cfg.provider === "cloud";
  const { profile } = req;
  const ctrl = cloud ? new AbortController() : undefined;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), cfg.timeoutFor(req.task)) : undefined;
  try {
    let response: Response;
    const send = async (): Promise<Response> => fetchFn(`${cfg.host}/api/chat`, {
      method: "POST",
      headers: authHeaders(cfg),
      ...(ctrl ? { signal: ctrl.signal } : {}),
      body: JSON.stringify({
        model,
        // local streams so response headers arrive at once (a non-streaming call to a large local model trips Node's 300s header timeout);
        // cloud returns whole JSON in one body, which also gives the timing fields without chunk bookkeeping
        stream: !cloud,
        format: req.format ?? "json",
        ...(cloud ? {} : { keep_alive: KEEP_ALIVE() }),
        options: { temperature: 0, ...(cloud ? {} : { num_ctx: NUM_CTX() }), ...(profile ? { num_predict: profile.num_predict } : {}) },
        ...(profile && !noThink.has(model) ? { think: profile.think } : {}),
        messages,
      }),
    });
    try { response = await send(); }
    catch (error) {
      if ((error as Error).name === "AbortError") throw new LlmError(`Ollama request timed out after ${cfg.timeoutFor(req.task)}ms`, "timeout", true);
      throw new LlmError(`Ollama is not reachable at ${cfg.host}. ${cloud ? "Check network access and OLLAMA_HOST" : `Start Ollama and pull ${model}`}: ${redact((error as Error).message, env)}`, "network", true);
    }

    if (!response.ok) {
      const err = (await response.json().catch(() => ({}))) as { error?: string };
      // a model without a thinking mode (e.g. mistral) rejects `think`: remember it and ask again without
      if (profile && !noThink.has(model) && /think/i.test(err.error ?? "")) { noThink.add(model); return once(cfg, req, messages, model, fetchFn, env); }
      const c = classify(response.status);
      const msg = c.status === "auth"
        ? `Ollama Cloud rejected the API key (${response.status}). Check OLLAMA_API_KEY.`
        : `Ollama compiler request failed (${response.status}): ${redact(err.error ?? "unknown error", env)}`;
      throw new LlmError(msg, c.status, c.retryable, response.status);
    }

    const timing: OllamaTiming = {};
    let content = "";
    try {
      if (cloud) {
        const body = (await response.json()) as { message?: { content?: string }; error?: string } & Record<string, unknown>;
        if (body.error) throw new LlmError(`Ollama compiler request failed (${response.status}): ${redact(body.error, env)}`, "5xx", true, response.status);
        content = body.message?.content ?? "";
        takeTiming(body, timing);
      } else {
        // NDJSON: one chunk per line, each carrying a slice of message.content.
        const eat = (line: string) => {
          if (!line.trim()) return;
          const chunk = JSON.parse(line) as { message?: { content?: string }; error?: string } & Record<string, unknown>;
          if (chunk.error) throw new Error(`Ollama compiler request failed (${response.status}): ${chunk.error}`);
          content += chunk.message?.content ?? "";
          takeTiming(chunk, timing);
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
      }
    } catch (error) {
      if (error instanceof LlmError) throw error;
      if ((error as Error).name === "AbortError") throw new LlmError(`Ollama request timed out after ${cfg.timeoutFor(req.task)}ms`, "timeout", true);
      throw error;
    }
    if (!content) throw new Error("Ollama compiler returned no text content");
    return { content, timing, httpStatus: response.status };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function chat(req: ChatRequest, deps: ChatDeps = {}): Promise<string> {
  const env = deps.env ?? process.env;
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const tel = deps.telemetry ?? getLlmTelemetry();
  const cfg = loadLlmConfig(env);
  const cloud = cfg.provider === "cloud";
  // telemetry must never fail a call
  const emit = (fn: () => void) => { try { fn(); } catch { /* sink down */ } };

  const models = cloud && req.fallback !== false ? [req.model, ...cfg.fallbackModels.filter((m) => m !== req.model)] : [req.model];
  const baseMessages = [{ role: "system", content: cloud ? withSchemaContract(req.system, req.format) : req.system }, { role: "user", content: req.user }];
  let last: LlmError | undefined;

  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi];
    for (let attempt = 0; attempt <= (cloud ? cfg.maxRetries : 0); attempt++) {
      const started = Date.now();
      const event = (status: CallStatus, extra: Partial<LlmCallEvent> = {}): LlmCallEvent => ({ provider: cfg.provider, model, task: req.task, status, latencyMs: Date.now() - started, attempt, ...extra });
      try {
        let r = await once(cfg, req, baseMessages, model, fetchFn, env);
        if (cloud) r = { ...r, content: unfence(r.content) };
        if (!cloud ? parses(r.content) : shapeProblem(r.content, req.format) === null) { emit(() => tel.call(event("ok", { timing: r.timing, httpStatus: r.httpStatus }))); return r.content; }
        // not parseable JSON: report it; on cloud make exactly one repair attempt, then leave verification to the caller
        emit(() => tel.call(event("bad_json", { timing: r.timing, httpStatus: r.httpStatus })));
        if (!cloud) return r.content;
        const repairStart = Date.now();
        try {
          const repaired = await once(cfg, req, [...baseMessages, { role: "assistant", content: r.content }, { role: "user", content: `Your previous reply was rejected: ${shapeProblem(r.content, req.format)}. Reply again with only the valid JSON object, no prose.` }], model, fetchFn, env);
          repaired.content = unfence(repaired.content);
          emit(() => tel.call({ ...event(shapeProblem(repaired.content, req.format) === null ? "ok" : "bad_json", { timing: repaired.timing, httpStatus: repaired.httpStatus }), latencyMs: Date.now() - repairStart }));
          return repaired.content;
        } catch { return r.content; }
      } catch (error) {
        if (!(error instanceof LlmError)) { emit(() => tel.call(event("network"))); throw error; }
        last = error;
        emit(() => tel.call(event(error.status, { httpStatus: error.httpStatus })));
        if (!cloud || !error.retryable) throw error;
        if (attempt < cfg.maxRetries) {
          emit(() => tel.retry({ model, status: error.status, attempt: attempt + 1 }));
          await sleep(250 + Math.floor(Math.random() * 500));   // jitter
        }
      }
    }
    if (mi + 1 < models.length) emit(() => tel.fallback({ from_model: model, to_model: models[mi + 1] }));
  }
  throw new Error(`The language model is temporarily unavailable (${last?.status ?? "error"}); please try again shortly.`);
}

export type ModelCheck = { ok: boolean; skipped?: boolean; missing: string[]; missingFallbacks: string[]; error?: string };

// Startup check: cloud models do get retired, so fail fast if the primary is not in /api/tags.
export async function checkModelAvailable(deps: { fetchFn?: typeof fetch; env?: NodeJS.ProcessEnv; model?: string } = {}): Promise<ModelCheck> {
  const env = deps.env ?? process.env;
  const cfg = loadLlmConfig(env);
  if (cfg.provider !== "cloud") return { ok: true, skipped: true, missing: [], missingFallbacks: [] };
  const model = deps.model ?? env.OLLAMA_COMPILER_MODEL ?? env.OLLAMA_MODEL ?? "gemma4:31b";
  const fetchFn = deps.fetchFn ?? fetch;
  let names: string[];
  try {
    const r = await fetchFn(`${cfg.host}/api/tags`, { headers: authHeaders(cfg), signal: AbortSignal.timeout(cfg.timeoutMs) });
    if (!r.ok) return { ok: false, missing: [model], missingFallbacks: [], error: `GET /api/tags failed (${r.status})` };
    const body = (await r.json()) as { models?: { name?: string; model?: string }[] };
    names = (body.models ?? []).map((m) => m.name ?? m.model ?? "");
  } catch (error) {
    return { ok: false, missing: [model], missingFallbacks: [], error: redact((error as Error).message, env) };
  }
  const have = new Set(names);
  return { ok: have.has(model), missing: have.has(model) ? [] : [model], missingFallbacks: cfg.fallbackModels.filter((m) => !have.has(m)) };
}
