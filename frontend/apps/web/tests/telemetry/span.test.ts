import { afterEach, describe, expect, it, vi } from "vitest";
import { agent, annotate, MemoryRunStore, newRunCtx, resetRuntime, task, tool, withRunCtx } from "@/server/telemetry";
import { setupTelemetry, teardownTelemetry } from "./helpers";

const run = () => newRunCtx({ runId: "11111111-1111-1111-1111-111111111111", traceId: "t".repeat(32), draftId: "d1", promptId: 7 });
afterEach(() => teardownTelemetry());

describe("disabled (no collector / DB configured)", () => {
  it("calls the function straight through: same result, same `this`, same errors, sync and async", async () => {
    resetRuntime();
    const obj = { v: 5, f: task("t", function (this: { v: number }, a: number) { return this.v + a; }) };
    expect(obj.f(2)).toBe(7);
    expect(await agent("a", async (x: number) => x * 2)(4)).toBe(8);
    expect(() => tool("x", () => { throw new Error("boom"); })()).toThrow("boom");
    await expect(tool("y", async () => { throw new Error("async boom"); })()).rejects.toThrow("async boom");
  });
});

describe("enabled", () => {
  it("nests task > agent > tool as spans with gen_ai attributes, for sync and async functions", async () => {
    const t = setupTelemetry();
    const toolFn = tool("price_fetch", (sym: string) => `px:${sym}`);
    const agentFn = agent("reader", async (s: string) => { await Promise.resolve(); return toolFn(s); }, { versionOf: "system prompt v1" });
    const taskFn = task("interpret", async (s: string) => agentFn(s));
    const out = await withRunCtx(run(), () => taskFn("ABC"));
    expect(out).toBe("px:ABC");
    const spans = t.finished();
    expect(spans.map((s) => s.name)).toEqual(["price_fetch", "reader", "interpret"]);
    const [toolSpan, agentSpan, taskSpan] = spans;
    expect(toolSpan.parentSpanContext?.spanId).toBe(agentSpan.spanContext().spanId);
    expect(agentSpan.parentSpanContext?.spanId).toBe(taskSpan.spanContext().spanId);
    expect(toolSpan.spanContext().traceId).toBe(taskSpan.spanContext().traceId);
    expect(toolSpan.attributes).toMatchObject({ "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "price_fetch" });
    expect(agentSpan.attributes).toMatchObject({ "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "reader" });
    expect(taskSpan.attributes).toMatchObject({ "task.name": "interpret", "prompt.id": 7 });
  });

  it("writes run rows that carry the task / agent context down the tree", async () => {
    const t = setupTelemetry();
    const tl = tool("t1", () => 1);
    const ag = agent("a1", () => tl(), { versionOf: "p" });
    const tk = task("k1", () => ag());
    withRunCtx(run(), () => { tk(); tk(); });
    const [first, second] = t.store.tasks;
    expect([first.seq, second.seq]).toEqual([1, 2]);
    expect(first.task_name).toBe("k1");
    expect(t.store.agents[0]).toMatchObject({ agent_name: "a1", task_span_id: first.span_id, run_id: run().runId });
    expect(t.store.agents[0].agent_version).toMatch(/^[0-9a-f]{12}$/);
    expect(t.store.tools[0]).toMatchObject({ tool_name: "t1", agent_span_id: t.store.agents[0].span_id, status: "ok" });
  });

  it("writes no rows (but still spans) outside a run", () => {
    const t = setupTelemetry();
    task("loose", () => 1)();
    expect(t.finished()).toHaveLength(1);
    expect(t.store.tasks).toHaveLength(0);
  });

  it("records errors: status error, ERROR span, rethrown unchanged, row has redacted message", async () => {
    const t = setupTelemetry();
    const bad = tool("bad", async () => { throw new Error("failed with Bearer abc123 for a@b.io"); });
    await expect(withRunCtx(run(), () => bad())).rejects.toThrow("failed with Bearer abc123");
    expect(t.finished()[0].status.code).toBe(2);
    expect(t.store.tools[0]).toMatchObject({ status: "error", error_type: "Error" });
    expect(t.store.tools[0].error_msg).toBe("failed with Bearer [redacted] for [redacted-email]");
  });

  it("annotate() sets rows in/out and a status override such as fallback", () => {
    const t = setupTelemetry();
    const f = tool("screen", () => { annotate({ rowsIn: 500, rowsOut: 12, status: "fallback", model: "gemma4:26b", inputTokens: 10, outputTokens: 4, gpuMs: 250 }); return "r"; });
    withRunCtx(run(), () => f());
    expect(t.store.tools[0]).toMatchObject({ status: "fallback", rows_in: 500, rows_out: 12, model: "gemma4:26b", input_tokens: 10, output_tokens: 4, gpu_ms: 250 });
    expect(t.finished()[0].attributes).toMatchObject({ "rows.in": 500, "rows.out": 12, "gen_ai.usage.input_tokens": 10 });
  });

  it("emits exactly one start and one end log line per call, carrying ids, redacted input and the trace id", () => {
    const t = setupTelemetry();
    const f = tool("lookup", (q: { apiKey: string; sym: string }) => ({ ok: q.sym }));
    withRunCtx(run(), () => f({ apiKey: "sk-secretsecret1", sym: "ABC" }));
    expect(t.logs("start")).toHaveLength(1);
    const [end] = t.logs("end");
    expect(t.logs("end")).toHaveLength(1);
    expect(end).toMatchObject({ kind: "tool", tool_name: "lookup", status: "ok", run_id: run().runId, prompt_id: 7 });
    expect(end.duration_ms).toBeGreaterThanOrEqual(0);
    expect(end.traceId).toBe(t.finished()[0].spanContext().traceId);
    const start = t.logs("start")[0];
    expect(start.input).toContain("[redacted]");
    expect(start.input).not.toContain("sk-secretsecret1");
  });

  it("marks truncated=true and cuts log fields at 16 KB while the run row keeps the full value", () => {
    const t = setupTelemetry();
    const f = tool("big", () => "y".repeat(40_000));
    withRunCtx(run(), () => f());
    const [end] = t.logs("end");
    expect(end.truncated).toBe(true);
    expect(String(end.output).length).toBeLessThanOrEqual(16 * 1024);
    expect((t.store.tools[0].output as string).length).toBe(40_000);
    expect(t.store.tools[0].truncated).toBe(false);
  });

  it("records per-level metrics", async () => {
    const t = setupTelemetry();
    withRunCtx(run(), () => { task("k", () => agent("a", () => tool("x", () => 1)())())(); });
    const names = (await t.metrics()).map((m) => m.descriptor.name);
    expect(names).toEqual(expect.arrayContaining(["task.duration", "agent.invocations", "agent.duration", "tool.calls", "tool.duration"]));
    const calls = (await t.metrics()).find((m) => m.descriptor.name === "tool.calls")!;
    expect(calls.dataPoints[0].attributes).toMatchObject({ tool: "x", status: "ok" });
    expect(calls.descriptor.unit).toBe("");
    expect((await t.metrics()).find((m) => m.descriptor.name === "task.duration")!.descriptor.unit).toBe("s");
  });

  it("a failing store or logger never changes the wrapped function's result", () => {
    const store = new MemoryRunStore();
    store.insertTool = () => { throw new Error("db down"); };
    setupTelemetry({ store });
    const f = tool("safe", () => 42);
    expect(withRunCtx(run(), () => f())).toBe(42);
  });

  it("does not run user code twice or swallow its return of undefined/null", () => {
    setupTelemetry();
    const spy = vi.fn(() => undefined);
    expect(tool("u", spy)()).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
