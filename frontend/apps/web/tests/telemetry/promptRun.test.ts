import { afterEach, describe, expect, it } from "vitest";
import { agent, currentRun, task } from "@/server/telemetry";
import { deriveRunIds, inPromptRun } from "@/server/telemetry/run";
import { setupTelemetry, teardownTelemetry } from "./helpers";

afterEach(() => teardownTelemetry());
const lookup = () => ({ userId: 42, createdAt: "2026-10-22T10:00:00.000Z" });

describe("deriveRunIds", () => {
  it("is deterministic per draft, well-formed, and differs between drafts", () => {
    const a = deriveRunIds(5), b = deriveRunIds(5), c = deriveRunIds(6);
    expect(a).toEqual(b);
    expect(a.traceId).toMatch(/^[0-9a-f]{32}$/); expect(a.rootSpanId).toMatch(/^[0-9a-f]{16}$/);
    expect(a.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(c.traceId).not.toBe(a.traceId);
  });
});

describe("inPromptRun", () => {
  it("passes straight through when telemetry is disabled", async () => {
    expect(await inPromptRun({ draftId: 1, stage: "compile" }, async () => "x")).toBe("x");
    expect(() => inPromptRun({ draftId: 1, stage: "compile" }, () => { throw new Error("boom"); })).toThrow("boom");
  });

  it("compile -> screen -> confirm are separate requests but ONE trace; the prompt.run root is emitted at confirm and is their parent", async () => {
    const t = setupTelemetry();
    const ids = deriveRunIds(9);
    await inPromptRun({ draftId: 9, stage: "compile", lookup }, async () => { await task("interpret", async () => 1)(); });
    await inPromptRun({ draftId: 9, stage: "screen", lookup }, async () => { await task("screen", async () => 1)(); });
    expect(t.finished().some((s) => s.name === "prompt.run")).toBe(false);          // root not emitted before confirm
    await inPromptRun({ draftId: 9, stage: "confirm", lookup, summarize: (r: { promptId: number }) => ({ promptId: r.promptId, outcome: "confirmed" }) }, async () => ({ promptId: 77 }));
    const spans = t.finished();
    expect(new Set(spans.map((s) => s.spanContext().traceId))).toEqual(new Set([ids.traceId]));
    const root = spans.find((s) => s.name === "prompt.run")!;
    expect(root.spanContext().spanId).toBe(ids.rootSpanId);
    expect(root.parentSpanContext?.spanId).toBeUndefined();
    expect(root.attributes).toMatchObject({ "prompt.id": 77, "prompt.outcome": "confirmed", "run.id": ids.runId });
    const stages = spans.filter((s) => /^prompt\.(compile|screen|confirm)$/.test(s.name));
    expect(stages.map((s) => s.name)).toEqual(["prompt.compile", "prompt.screen", "prompt.confirm"]);
    for (const s of stages) expect(s.parentSpanContext?.spanId).toBe(ids.rootSpanId);
    const interpret = spans.find((s) => s.name === "interpret")!;
    expect(interpret.parentSpanContext?.spanId).toBe(stages[0].spanContext().spanId);
    expect(new Date(root.startTime[0] * 1000).toISOString().slice(0, 10)).toBe("2026-10-22");   // starts at draft creation
  });

  it("maintains the runs row: running from the first request, ok + prompt_id at confirm; user is hashed", async () => {
    const t = setupTelemetry();
    const ids = deriveRunIds(3);
    await inPromptRun({ draftId: 3, stage: "compile", lookup }, async () => 1);
    expect(t.store.runs.get(ids.traceId)).toMatchObject({ run_id: ids.runId, kind: "prompt_run", draft_id: "3", status: "running" });
    expect(t.store.runs.get(ids.traceId)!.user_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify([...t.store.runs.values()])).not.toContain('"42"');
    await inPromptRun({ draftId: 3, stage: "confirm", lookup, summarize: () => ({ promptId: 12, outcome: "confirmed" }) }, async () => 1);
    expect(t.store.runs.get(ids.traceId)).toMatchObject({ status: "ok", prompt_id: 12, outcome: "confirmed" });
    expect(t.store.runs.get(ids.traceId)!.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("a failed confirm marks the run error, emits the root with ERROR status, and rethrows", async () => {
    const t = setupTelemetry();
    const ids = deriveRunIds(4);
    await expect(inPromptRun({ draftId: 4, stage: "confirm", lookup }, async () => { throw new Error("engine said 422 for a@b.io"); })).rejects.toThrow("engine said 422");
    expect(t.store.runs.get(ids.traceId)).toMatchObject({ status: "error", outcome: "failed", error_type: "Error" });
    expect(t.store.runs.get(ids.traceId)!.error_msg).toBe("engine said 422 for [redacted-email]");
    expect(t.finished().find((s) => s.name === "prompt.run")!.status.code).toBe(2);
  });

  it("a failed compile/screen does not close the run (the user can retry)", async () => {
    const t = setupTelemetry();
    await expect(inPromptRun({ draftId: 6, stage: "screen", lookup }, async () => { throw new Error("nope"); })).rejects.toThrow("nope");
    expect(t.store.runs.get(deriveRunIds(6).traceId)!.status).toBe("running");
    expect(t.finished().find((s) => s.name === "prompt.screen")!.status.code).toBe(2);
  });

  it("nested calls for the same draft (editProgramClause -> compile) reuse the outer stage", async () => {
    const t = setupTelemetry();
    await inPromptRun({ draftId: 8, stage: "compile", lookup }, () => inPromptRun({ draftId: 8, stage: "compile", lookup }, async () => 1));
    expect(t.finished().filter((s) => s.name === "prompt.compile")).toHaveLength(1);
  });

  it("task rows written below a stage carry the deterministic run id", async () => {
    const t = setupTelemetry();
    await inPromptRun({ draftId: 2, stage: "compile", lookup }, async () => { await agent("reader", async () => currentRun()?.runId)(); });
    expect(t.store.agents[0].run_id).toBe(deriveRunIds(2).runId);
  });
});

describe("inJobRun (weekly / catch-up jobs run outside any HTTP request)", () => {
  it("is a pass-through when disabled", async () => {
    const { inJobRun } = await import("@/server/telemetry/run");
    expect(await inJobRun({ name: "catch_up" }, async () => 5)).toBe(5);
  });

  it("opens its own trace + weekly_job run row, tasks below it attach to it, and it closes ok / error", async () => {
    const { inJobRun } = await import("@/server/telemetry/run");
    const t = setupTelemetry();
    await inJobRun({ name: "catch_up", promptId: 12 }, async () => { await task("weekly_screen", async () => 1)(); });
    const [row] = [...t.store.runs.values()];
    expect(row).toMatchObject({ kind: "weekly_job", status: "ok", prompt_id: 12, outcome: "catch_up" });
    expect(row.attrs).toMatchObject({ job: "catch_up" });
    expect(t.store.tasks[0]).toMatchObject({ task_name: "weekly_screen", run_id: row.run_id, trace_id: row.trace_id });
    const spans = t.finished();
    expect(spans.find((s) => s.name === "job.catch_up")!.parentSpanContext?.spanId).toBeUndefined();
    expect(spans.find((s) => s.name === "weekly_screen")!.parentSpanContext?.spanId).toBe(spans.find((s) => s.name === "job.catch_up")!.spanContext().spanId);

    await expect(inJobRun({ name: "catch_up", promptId: 13 }, async () => { throw new Error("grading blew up"); })).rejects.toThrow("grading blew up");
    const failed = [...t.store.runs.values()].find((r) => r.prompt_id === 13)!;
    expect(failed).toMatchObject({ status: "error", error_type: "Error" });
    expect(new Set([...t.store.runs.values()].map((r) => r.trace_id)).size).toBe(2);   // separate runs, separate traces
  });
});

describe("prompt.run.duration metric", () => {
  it("records each request's processing time by stage and outcome (not wall-clock since the draft was created)", async () => {
    const t = setupTelemetry();
    await inPromptRun({ draftId: 21, stage: "compile", lookup: () => ({ userId: 1, createdAt: "2020-01-01T00:00:00.000Z" }) }, async () => 1);
    await expect(inPromptRun({ draftId: 21, stage: "screen", lookup }, async () => { throw new Error("x"); })).rejects.toThrow();
    const m = (await t.metrics()).find((x) => x.descriptor.name === "prompt.run.duration")!;
    expect(m.descriptor.unit).toBe("s");
    const pts = (m.dataPoints as any[]).map((d) => ({ ...d.attributes, count: d.value.count, sum: d.value.sum }));
    expect(pts.map((p) => `${p.stage}:${p.outcome}`).sort()).toEqual(["compile:ok", "screen:error"]);
    expect(pts.every((p) => p.sum < 5)).toBe(true);        // milliseconds of work, even though the draft is "years" old
  });
});
