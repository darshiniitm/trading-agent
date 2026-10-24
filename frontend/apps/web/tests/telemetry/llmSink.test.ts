import { afterEach, describe, expect, it, vi } from "vitest";
import { agent, newRunCtx, withRunCtx } from "@/server/telemetry";
import { installLlmTelemetry } from "@/server/telemetry/llmSink";
import { getLlmTelemetry, setLlmTelemetry, type LlmCallEvent } from "@/server/llm/telemetry";
import { chat } from "@/server/llm/client";
import { setupTelemetry, teardownTelemetry } from "./helpers";

const run = () => newRunCtx({ runId: "11111111-1111-1111-1111-111111111111", traceId: "t".repeat(32), promptId: 7 });
const ev = (over: Partial<LlmCallEvent> = {}): LlmCallEvent => ({ provider: "cloud", model: "gemma4:31b", task: "reader", status: "ok", latencyMs: 1500, attempt: 0,
  timing: { total_duration: 2.5e9, load_duration: 1e8, prompt_eval_count: 120, eval_count: 40, eval_duration: 2e9 }, ...over });
afterEach(() => { teardownTelemetry(); setLlmTelemetry(null); });

describe("llm sink", () => {
  it("turns a call event into a child llm.chat span with gen_ai attributes, backdated by latencyMs", () => {
    const t = setupTelemetry(); installLlmTelemetry();
    const a = agent("reader", () => { getLlmTelemetry().call(ev()); });
    withRunCtx(run(), () => a());
    const [llm, ag] = t.finished();
    expect(llm.name).toBe("llm.chat");
    expect(llm.parentSpanContext?.spanId).toBe(ag.spanContext().spanId);
    expect(llm.attributes).toMatchObject({ "gen_ai.operation.name": "chat", "gen_ai.request.model": "gemma4:31b", "gen_ai.system": "ollama", "gen_ai.usage.input_tokens": 120, "gen_ai.usage.output_tokens": 40, "llm.task": "reader", "llm.attempt": 0 });
    const ms = (llm.endTime[0] - llm.startTime[0]) * 1000 + (llm.endTime[1] - llm.startTime[1]) / 1e6;
    expect(Math.round(ms)).toBeGreaterThanOrEqual(1499);
  });

  it("records the metrics: duration (s), requests by status, tokens by direction, gpu seconds", async () => {
    const t = setupTelemetry(); installLlmTelemetry();
    getLlmTelemetry().call(ev()); getLlmTelemetry().call(ev({ status: "429", timing: undefined }));
    const m = await t.metrics(); const by = (n: string) => m.find((x) => x.descriptor.name === n)!;
    expect(by("llm.request.duration").descriptor.unit).toBe("s");
    expect(by("llm.requests").dataPoints.map((d: any) => [d.attributes.status, d.value]).sort()).toEqual([["429", 1], ["ok", 1]]);
    expect(by("llm.tokens").dataPoints.map((d: any) => [d.attributes.direction, d.value]).sort()).toEqual([["completion", 40], ["prompt", 120]]);
    expect((by("llm.gpu").dataPoints[0] as any).value).toBeCloseTo(2.5, 5);
    expect(by("llm.gpu").descriptor.unit).toBe("s");
  });

  it("retry and fallback events count and mark the enclosing agent (status fallback, model/tokens rolled up)", async () => {
    const t = setupTelemetry(); installLlmTelemetry();
    const a = agent("reader", () => {
      const s = getLlmTelemetry();
      s.call(ev({ status: "5xx", timing: undefined, attempt: 0 })); s.retry({ model: "gemma4:31b", status: "5xx", attempt: 1 });
      s.call(ev({ status: "5xx", timing: undefined, attempt: 1 })); s.fallback({ from_model: "gemma4:31b", to_model: "gemma4:26b" });
      s.call(ev({ model: "gemma4:26b" }));
    });
    withRunCtx(run(), () => a());
    const row = t.store.agents[0];
    expect(row).toMatchObject({ status: "fallback", model: "gemma4:26b", provider: "cloud", input_tokens: 120, output_tokens: 40, gpu_ms: 2500 });
    const m = await t.metrics();
    const fb = m.find((x) => x.descriptor.name === "llm.fallback")!.dataPoints[0] as any;
    expect(fb.attributes).toMatchObject({ from_model: "gemma4:31b", to_model: "gemma4:26b" }); expect(fb.value).toBe(1);
    expect((m.find((x) => x.descriptor.name === "llm.retry")!.dataPoints[0] as any).value).toBe(1);
  });

  it("stores each attempt as a tool_calls row (tool_name llm.chat) with token / gpu columns; failures are status error", () => {
    const t = setupTelemetry(); installLlmTelemetry();
    withRunCtx(run(), () => { getLlmTelemetry().call(ev()); getLlmTelemetry().call(ev({ status: "bad_json", timing: undefined })); });
    expect(t.store.tools).toHaveLength(2);
    expect(t.store.tools[0]).toMatchObject({ tool_name: "llm.chat", status: "ok", model: "gemma4:31b", provider: "cloud", input_tokens: 120, output_tokens: 40, gpu_ms: 2500 });
    expect(t.store.tools[1]).toMatchObject({ status: "error", error_type: "bad_json" });
    expect(t.store.tools[0].span_id).not.toBe(t.store.tools[1].span_id);
  });

  it("emits one log line per attempt and writes nothing outside a run (but still spans / metrics)", () => {
    const t = setupTelemetry(); installLlmTelemetry();
    getLlmTelemetry().call(ev());
    expect(t.logs("end").filter((l) => l.kind === "llm")).toHaveLength(1);
    expect(t.store.tools).toHaveLength(0);
    expect(t.finished()).toHaveLength(1);
  });

  it("is idempotent, a no-op while telemetry is disabled, and never throws", () => {
    installLlmTelemetry(); installLlmTelemetry();
    expect(() => getLlmTelemetry().call(ev())).not.toThrow();      // runtime disabled
    const t = setupTelemetry(); installLlmTelemetry();
    t.store.insertTool = () => { throw new Error("db"); };
    expect(() => withRunCtx(run(), () => getLlmTelemetry().call(ev()))).not.toThrow();
  });

  it("survives module re-evaluation (Next dev): the sink installed in one copy is seen by another", async () => {
    setupTelemetry(); installLlmTelemetry();
    vi.resetModules();
    const fresh = await import("@/server/llm/telemetry");
    expect(fresh.getLlmTelemetry()).toBe(getLlmTelemetry());
    expect(fresh.getLlmTelemetry()).not.toBe(fresh.noopTelemetry);
  });

  it("end to end: a real chat() call (mock fetch) reaches the sink", async () => {
    const t = setupTelemetry(); installLlmTelemetry();
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers(), json: async () => ({ message: { content: "{}" }, done: true, prompt_eval_count: 9, eval_count: 3, total_duration: 1e9 }) });
    await withRunCtx(run(), () => chat({ system: "s", user: "u", model: "m" }, { fetchFn: f as any, env: { LLM_PROVIDER: "cloud", OLLAMA_API_KEY: "k" } as any }));
    expect(t.store.tools[0]).toMatchObject({ tool_name: "llm.chat", input_tokens: 9, output_tokens: 3, gpu_ms: 1000 });
  });
});
