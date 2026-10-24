// Ollama Cloud client: provider config, auth, timeout, retry/fallback, JSON repair, redaction, startup check, telemetry.
import { describe, expect, it, vi } from "vitest";
import { loadLlmConfig } from "@/server/llm/config";
import { chat, checkModelAvailable } from "@/server/llm/client";
import type { LlmTelemetry, LlmCallEvent } from "@/server/llm/telemetry";

const CLOUD = { LLM_PROVIDER: "cloud", OLLAMA_API_KEY: "sk-test-SECRET", OLLAMA_MODEL: "gemma4:31b" } as unknown as NodeJS.ProcessEnv;
const json = (body: object, status = 200, headers: Record<string, string> = {}) => ({ ok: status < 400, status, headers: new Headers(headers), json: async () => body });
const reply = (content: string, extra: object = {}) => json({ message: { content }, done: true, ...extra });
const sleep = vi.fn(async () => {});
const mkTelemetry = () => {
  const calls: LlmCallEvent[] = [], retries: any[] = [], fallbacks: any[] = [];
  const t: LlmTelemetry = { call: (e) => calls.push(e), retry: (e) => retries.push(e), fallback: (e) => fallbacks.push(e) };
  return { t, calls, retries, fallbacks };
};
const req = (over: object = {}) => ({ system: "s", user: "u", model: "gemma4:31b", fallback: true, ...over });

describe("loadLlmConfig", () => {
  it("defaults to local with the legacy base url and no auth", () => {
    const c = loadLlmConfig({} as any);
    expect(c.provider).toBe("local");
    expect(c.host).toBe("http://127.0.0.1:11434");
    expect(c.apiKey).toBeUndefined();
    expect(c.fallbackModels).toEqual([]);
  });

  it("cloud defaults: ollama.com, plan values, comma-separated fallbacks", () => {
    const c = loadLlmConfig({ ...CLOUD, OLLAMA_FALLBACK_MODELS: " gemma4:26b, other:1 " } as any);
    expect(c).toMatchObject({ provider: "cloud", host: "https://ollama.com", timeoutMs: 8000, maxRetries: 1, apiKey: "sk-test-SECRET" });
    expect(c.fallbackModels).toEqual(["gemma4:26b", "other:1"]);
  });

  it("rejects cloud without a key and unknown providers", () => {
    expect(() => loadLlmConfig({ LLM_PROVIDER: "cloud" } as any)).toThrow(/OLLAMA_API_KEY/);
    expect(() => loadLlmConfig({ LLM_PROVIDER: "nope" } as any)).toThrow(/LLM_PROVIDER/);
  });

  it("per-task timeout override", () => {
    const c = loadLlmConfig({ ...CLOUD, LLM_TIMEOUT_MS_MODELREAD: "30000" } as any);
    expect(c.timeoutFor("modelRead")).toBe(30000);
    expect(c.timeoutFor("critic")).toBe(8000);
  });
});

describe("chat — cloud request shape", () => {
  it("posts to /api/chat with a bearer header, stream:false and no local-only options", async () => {
    const f = vi.fn().mockResolvedValue(reply('{"a":1}'));
    const out = await chat(req({ format: { type: "object" }, profile: { think: false, num_predict: 768 } }), { fetchFn: f as any, env: CLOUD, sleep });
    expect(out).toBe('{"a":1}');
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://ollama.com/api/chat");
    expect(init.headers.authorization).toBe("Bearer sk-test-SECRET");
    const b = JSON.parse(init.body);
    expect(b).toMatchObject({ stream: false, think: false, format: { type: "object" }, options: { temperature: 0, num_predict: 768 } });
    expect("keep_alive" in b).toBe(false);
    expect("num_ctx" in b.options).toBe(false);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("local mode sends no auth header and no abort signal", async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify({ message: { content: "{}" }, done: true }) + "\n")); c.close(); } }) });
    await chat(req(), { fetchFn: f as any, env: {} as any, sleep });
    expect(f.mock.calls[0][1].headers.authorization).toBeUndefined();
    expect(f.mock.calls[0][1].signal).toBeUndefined();
    expect(JSON.parse(f.mock.calls[0][1].body).stream).toBe(true);
  });
});

describe("chat — schema contract (cloud does not constrain decoding to `format`)", () => {
  const schema = { type: "object", properties: { conditions: { type: "array" } }, required: ["conditions"] };

  it("cloud: puts the JSON Schema in the system prompt; local leaves the prompt untouched", async () => {
    const f = vi.fn().mockResolvedValue(reply('{"conditions":[]}'));
    await chat(req({ format: schema }), { fetchFn: f as any, env: CLOUD, sleep });
    const sys = JSON.parse(f.mock.calls[0][1].body).messages[0].content as string;
    expect(sys.startsWith("s")).toBe(true);
    expect(sys).toContain('"required":["conditions"]');
    expect(sys).toMatch(/only .*JSON/i);

    const g = vi.fn().mockResolvedValue({ ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify({ message: { content: "{}" }, done: true }) + "\n")); c.close(); } }) });
    await chat(req({ format: schema }), { fetchFn: g as any, env: {} as any, sleep });
    expect(JSON.parse(g.mock.calls[0][1].body).messages[0].content).toBe("s");
  });

  it("cloud: valid JSON that lacks a required top-level key gets one repair that names the missing key", async () => {
    const f = vi.fn().mockResolvedValueOnce(reply('{"sky_color":"blue"}')).mockResolvedValue(reply('{"conditions":[]}'));
    const tm = mkTelemetry();
    expect(await chat(req({ format: schema }), { fetchFn: f as any, env: CLOUD, sleep, telemetry: tm.t })).toBe('{"conditions":[]}');
    expect(JSON.parse(f.mock.calls[1][1].body).messages.at(-1).content).toMatch(/conditions/);
    expect(tm.calls.map((c) => c.status)).toEqual(["bad_json", "ok"]);
  });

  it("no schema given (plain JSON mode): nothing is injected", async () => {
    const f = vi.fn().mockResolvedValue(reply("{}"));
    await chat(req(), { fetchFn: f as any, env: CLOUD, sleep });
    expect(JSON.parse(f.mock.calls[0][1].body).messages[0].content).toMatch(/^s/);
    expect(JSON.parse(f.mock.calls[0][1].body).messages[0].content).not.toContain("Schema");
  });
});

describe("chat — retry and fallback (cloud)", () => {
  it("retries once on 429 then succeeds", async () => {
    const f = vi.fn().mockResolvedValueOnce(json({ error: "rate" }, 429)).mockResolvedValue(reply("{}"));
    const tm = mkTelemetry();
    expect(await chat(req(), { fetchFn: f as any, env: CLOUD, sleep, telemetry: tm.t })).toBe("{}");
    expect(f).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalled();
    expect(tm.calls.map((c) => c.status)).toEqual(["429", "ok"]);
    expect(tm.retries).toHaveLength(1);
  });

  it("after the retry is spent, moves to the next fallback model; no looping", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json({}, 503))   // primary + its retry
      .mockResolvedValue(reply('{"ok":1}'));                                        // fallback
    const tm = mkTelemetry();
    const out = await chat(req(), { fetchFn: f as any, env: { ...CLOUD, OLLAMA_FALLBACK_MODELS: "gemma4:26b" } as any, sleep, telemetry: tm.t });
    expect(out).toBe('{"ok":1}');
    expect(f).toHaveBeenCalledTimes(3);
    expect(JSON.parse(f.mock.calls[2][1].body).model).toBe("gemma4:26b");
    expect(tm.fallbacks).toEqual([{ from_model: "gemma4:31b", to_model: "gemma4:26b" }]);
    expect(tm.calls.map((c) => c.status)).toEqual(["5xx", "5xx", "ok"]);
  });

  it("with no fallback configured, a persistent failure surfaces a clear retry-shortly error", async () => {
    const f = vi.fn().mockResolvedValue(json({ error: "busy" }, 503));
    await expect(chat(req(), { fetchFn: f as any, env: CLOUD, sleep })).rejects.toThrow(/try again shortly/i);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("does not use the fallback chain when the caller pinned a model", async () => {
    const f = vi.fn().mockResolvedValue(json({}, 503));
    await expect(chat(req({ fallback: false }), { fetchFn: f as any, env: { ...CLOUD, OLLAMA_FALLBACK_MODELS: "gemma4:26b" } as any, sleep })).rejects.toThrow();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("does not retry client errors (401/404) and names the cause", async () => {
    const f = vi.fn().mockResolvedValue(json({ error: "unauthorized" }, 401));
    await expect(chat(req(), { fetchFn: f as any, env: CLOUD, sleep })).rejects.toThrow(/API key|401/);
    expect(f).toHaveBeenCalledTimes(1);
    const g = vi.fn().mockResolvedValue(json({ error: "model not found" }, 404));
    await expect(chat(req(), { fetchFn: g as any, env: CLOUD, sleep })).rejects.toThrow(/model not found/);
    expect(g).toHaveBeenCalledTimes(1);
  });

  it("treats an aborted request as a timeout (retryable)", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const f = vi.fn().mockRejectedValueOnce(abort).mockResolvedValue(reply("{}"));
    const tm = mkTelemetry();
    await chat(req(), { fetchFn: f as any, env: CLOUD, sleep, telemetry: tm.t });
    expect(tm.calls.map((c) => c.status)).toEqual(["timeout", "ok"]);
  });

  it("local mode never retries or falls back (behaviour unchanged)", async () => {
    const f = vi.fn().mockResolvedValue(json({ error: "boom" }, 503));
    await expect(chat(req(), { fetchFn: f as any, env: { OLLAMA_FALLBACK_MODELS: "x" } as any, sleep })).rejects.toThrow();
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("chat — structured output validation", () => {
  it("unwraps a markdown-fenced JSON reply (cloud does not hard-constrain decoding) without a repair call", async () => {
    const f = vi.fn().mockResolvedValue(reply('```json\n{"ok":true}\n```'));
    const tm = mkTelemetry();
    expect(await chat(req(), { fetchFn: f as any, env: CLOUD, sleep, telemetry: tm.t })).toBe('{"ok":true}');
    expect(f).toHaveBeenCalledTimes(1);
    expect(tm.calls.map((c) => c.status)).toEqual(["ok"]);
  });

  it("makes one repair attempt when the JSON does not parse", async () => {
    const f = vi.fn().mockResolvedValueOnce(reply("{broken")).mockResolvedValue(reply('{"fixed":true}'));
    const tm = mkTelemetry();
    expect(await chat(req(), { fetchFn: f as any, env: CLOUD, sleep, telemetry: tm.t })).toBe('{"fixed":true}');
    expect(f).toHaveBeenCalledTimes(2);
    expect(JSON.parse(f.mock.calls[1][1].body).messages.at(-1).content).toMatch(/valid JSON/i);
    expect(tm.calls.map((c) => c.status)).toEqual(["bad_json", "ok"]);
  });

  it("if the repair also fails, returns the text and leaves verification to the caller (one repair only)", async () => {
    const f = vi.fn().mockResolvedValue(reply("{still broken"));
    expect(await chat(req(), { fetchFn: f as any, env: CLOUD, sleep })).toBe("{still broken");
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe("chat — telemetry and redaction", () => {
  it("reports ollama's own timing fields", async () => {
    const f = vi.fn().mockResolvedValue(reply("{}", { total_duration: 5e9, load_duration: 1e9, prompt_eval_count: 120, eval_count: 40, eval_duration: 3e9 }));
    const tm = mkTelemetry();
    await chat(req({ task: "critic" }), { fetchFn: f as any, env: CLOUD, sleep, telemetry: tm.t });
    expect(tm.calls[0]).toMatchObject({ provider: "cloud", model: "gemma4:31b", task: "critic", status: "ok", latencyMs: expect.any(Number),
      timing: { total_duration: 5e9, load_duration: 1e9, prompt_eval_count: 120, eval_count: 40, eval_duration: 3e9 } });
  });

  it("a throwing telemetry sink never fails the call", async () => {
    const f = vi.fn().mockResolvedValue(reply("{}"));
    const t: LlmTelemetry = { call: () => { throw new Error("sink down"); }, retry: () => {}, fallback: () => {} };
    expect(await chat(req(), { fetchFn: f as any, env: CLOUD, sleep, telemetry: t })).toBe("{}");
  });

  it("never leaks the API key in errors", async () => {
    const f = vi.fn().mockRejectedValue(new Error("connect failed Authorization: Bearer sk-test-SECRET host=ollama.com"));
    const err = (await chat(req(), { fetchFn: f as any, env: CLOUD, sleep }).catch((e) => e)) as Error;
    expect(String(err.message)).not.toContain("sk-test-SECRET");
  });
});

describe("checkModelAvailable (startup check)", () => {
  const tags = (...names: string[]) => json({ models: names.map((name) => ({ name })) });

  it("passes when the model is listed (sends auth)", async () => {
    const f = vi.fn().mockResolvedValue(tags("gemma4:31b", "gemma4:26b"));
    const r = await checkModelAvailable({ fetchFn: f as any, env: { ...CLOUD, OLLAMA_FALLBACK_MODELS: "gemma4:26b,gone:1" } as any });
    expect(r).toEqual({ ok: true, missing: [], missingFallbacks: ["gone:1"] });
    expect(f.mock.calls[0][0]).toBe("https://ollama.com/api/tags");
    expect(f.mock.calls[0][1].headers.authorization).toBe("Bearer sk-test-SECRET");
  });

  it("fails fast when the primary model is not listed", async () => {
    const f = vi.fn().mockResolvedValue(tags("other:1"));
    const r = await checkModelAvailable({ fetchFn: f as any, env: CLOUD });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["gemma4:31b"]);
  });

  it("is skipped for the local provider", async () => {
    const f = vi.fn();
    expect(await checkModelAvailable({ fetchFn: f as any, env: {} as any })).toMatchObject({ ok: true, skipped: true });
    expect(f).not.toHaveBeenCalled();
  });
});
