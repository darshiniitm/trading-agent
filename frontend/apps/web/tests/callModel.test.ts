import { describe, expect, it, vi, afterEach } from "vitest";

describe("callOllama", () => {
  afterEach(() => vi.restoreAllMocks());

  it("calls the local Ollama chat endpoint and returns the model content", async () => {
    const { callOllama } = await import("@/server/compiler/callModel");
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ message: { content: '{"ok":true}' } }) });
    const result = await callOllama("system prompt", "user prompt", undefined, fetchFn as any);
    expect(result).toBe('{"ok":true}');
    expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining("/api/chat"), expect.objectContaining({ method: "POST" }));
    const options = JSON.parse(fetchFn.mock.calls[0][1].body);
    expect(options.messages).toEqual([{ role: "system", content: "system prompt" }, { role: "user", content: "user prompt" }]);
    expect(options.stream).toBe(false);
    expect(options.format).toBe("json");
  });

  it("passes a JSON Schema as Ollama's structured-output format when given one", async () => {
    const { callOllama } = await import("@/server/compiler/callModel");
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ message: { content: "{}" } }) });
    const schema = { type: "object", required: ["a"] };
    await callOllama("s", "u", schema, fetchFn as any);
    expect(JSON.parse(fetchFn.mock.calls[0][1].body).format).toEqual(schema);
  });

  it("reports a useful error when Ollama is unavailable", async () => {
    const { callOllama } = await import("@/server/compiler/callModel");
    const fetchFn = vi.fn().mockRejectedValue(new Error("connection refused"));
    await expect(callOllama("system", "user", undefined, fetchFn as any)).rejects.toThrow(/Ollama is not reachable/);
  });

  it("surfaces Ollama API errors", async () => {
    const { callOllama } = await import("@/server/compiler/callModel");
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: "model not found" }) });
    await expect(callOllama("system", "user", undefined, fetchFn as any)).rejects.toThrow(/model not found/);
  });
});
