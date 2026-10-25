// The real compile -> screen -> confirm path, with telemetry installed (in-memory) and a stubbed model / engine.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { createDraft, updateDraft } from "@/server/drafts";
import { compileProgramDraft, screenProgramDraft } from "@/server/compileProgramDraft";
import { confirmDraft } from "@/server/confirm";
import { installLlmTelemetry } from "@/server/telemetry/llmSink";
import { deriveRunIds } from "@/server/telemetry/run";
import { engineToolName } from "@/server/engine/client";
import { GOLDEN_INTERPRETER } from "@/server/compiler/v5/goldenInterpreter";
import { setLlmTelemetry } from "@/server/llm/telemetry";
import { readyDraft } from "../helpers/program";
import { SAMPLE } from "../v5/samples";
import { setupTelemetry, teardownTelemetry } from "./helpers";

afterEach(async () => { teardownTelemetry(); setLlmTelemetry(null); });

const candidates = [{ ticker: "FULL1", membership: "full_match", values: { C1: 25000, C2: { vstop_line: 90, uptrend: true } }, failed_ids: [], ep: 101.5, sl: 95.0, r: 0.064 }];
const engineFetch = () => vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ candidates, applied_steps: [{ step: "x", applied: true, reason: null }], funnel: [], sector_view: [], entered: [], not_confirmed: [], no_point_data: [], watching: [] }) });

async function draftWith(text: string) {
  const raw = await createTestDb();
  const { draftId } = await createDraft(raw, { userId: await ensureOwnerUser(raw) });
  await updateDraft(raw, draftId, { promptText: text });
  return { raw, draftId };
}

describe("compile", () => {
  it("rules-only prompt: interpreter task, conditions.resolve and the draft write are traced; no agent rows", async () => {
    const t = setupTelemetry();
    const { raw, draftId } = await draftWith(SAMPLE);
    await compileProgramDraft(raw, draftId);
    const ids = deriveRunIds(draftId);
    expect(t.store.tasks.map((x) => x.task_name)).toEqual(["interpret"]);
    expect(t.store.tools.map((x) => x.tool_name)).toEqual(expect.arrayContaining(["conditions.resolve", "warehouse.write"]));
    expect(t.store.agents).toHaveLength(0);
    expect(t.finished().find((s) => s.name === "interpreter.parse")).toBeTruthy();
    expect(new Set(t.finished().map((s) => s.spanContext().traceId))).toEqual(new Set([ids.traceId]));
    expect(t.store.runs.get(ids.traceId)).toMatchObject({ status: "running", draft_id: String(draftId) });
  });

  it("a prompt the rules cannot read: model agents appear as agent rows with a prompt-hash version, and llm.chat rows hang under them", async () => {
    const t = setupTelemetry(); installLlmTelemetry();
    const text = GOLDEN_INTERPRETER.find((c) => c.needsModel)!.text;
    const { raw, draftId } = await draftWith(text);
    const callModel = vi.fn(async () => '{"conditions": []}');
    await compileProgramDraft(raw, draftId, { callModel });
    expect(callModel).toHaveBeenCalled();
    expect(t.store.agents.length).toBeGreaterThan(0);
    for (const a of t.store.agents) expect(a.agent_version).toMatch(/^[0-9a-f]{12}$/);
    expect(t.store.agents.map((a) => a.agent_name).every((n) => ["clause_fallback", "model_reader", "reader", "model_critic"].includes(n))).toBe(true);
    // the agent's version is stable across runs (same static prompt)
    const again = await draftWith(text);
    const before = t.store.agents[0].agent_version;
    await compileProgramDraft(again.raw, again.draftId, { callModel });
    expect(t.store.agents.find((a) => a.run_id === deriveRunIds(again.draftId).runId)!.agent_version).toBe(before);
  });
});

describe("screen + confirm", () => {
  it("engine calls are tool spans named by endpoint and carry traceparent + run id; confirm closes the run with the prompt id", async () => {
    const t = setupTelemetry();
    const raw = await createTestDb();
    const draftId = await readyDraft(raw);
    const fetchFn = engineFetch();
    await screenProgramDraft(raw, draftId, "2026-10-02", fetchFn as any);
    const [, init] = fetchFn.mock.calls[0];
    const h = new Headers(init.headers);
    expect(h.get("traceparent")).toMatch(new RegExp(`^00-${deriveRunIds(draftId).traceId}-[0-9a-f]{16}-01$`));
    expect(h.get("x-run-id")).toBe(deriveRunIds(draftId).runId);
    expect(t.store.tools.map((x) => x.tool_name)).toContain("engine.screen");
    expect(t.store.tasks.map((x) => x.task_name)).toContain("screen");

    const { promptId } = await confirmDraft(raw, draftId, "2026-10-02", fetchFn as any);
    const run = t.store.runs.get(deriveRunIds(draftId).traceId)!;
    expect(run).toMatchObject({ status: "ok", prompt_id: promptId });
    expect(t.store.tasks.map((x) => x.task_name)).toEqual(expect.arrayContaining(["screen", "weekly_screen"]));
    expect(t.store.tools.filter((x) => x.tool_name === "warehouse.write").length).toBeGreaterThanOrEqual(2);
    const root = t.finished().find((s) => s.name === "prompt.run")!;
    expect(root.spanContext().spanId).toBe(deriveRunIds(draftId).rootSpanId);
    expect(root.attributes["prompt.id"]).toBe(promptId);
  });

  it("a failed engine screen at confirm fails the run (error) and still propagates the original error", async () => {
    const t = setupTelemetry();
    const raw = await createTestDb();
    const draftId = await readyDraft(raw);
    const bad = vi.fn().mockResolvedValue({ ok: false, status: 422, text: async () => JSON.stringify({ error: "bad program" }) });
    await expect(await confirmDraft(raw, draftId, "2026-10-02", bad as any)).rejects.toThrow(/status 422/);
    expect(t.store.runs.get(deriveRunIds(draftId).traceId)).toMatchObject({ status: "error", outcome: "failed" });
    expect(t.store.tools.find((x) => x.tool_name === "engine.screen")).toMatchObject({ status: "error" });
  });

  it("without telemetry installed the same path behaves as before (no throw, no extra headers)", async () => {
    const raw = await createTestDb();
    const draftId = await readyDraft(raw);
    const fetchFn = engineFetch();
    await screenProgramDraft(raw, draftId, "2026-10-02", fetchFn as any);
    expect(new Headers(fetchFn.mock.calls[0][1].headers).get("traceparent")).toBeNull();
  });
});

describe("engineToolName", () => {
  it.each([["/screen/v5", "engine.screen"], ["/screen", "engine.screen"], ["/feasibility", "engine.feasibility"], ["/series/ABC.NS?tf=1D", "engine.series"], ["/select", "engine.select"],
    ["/arms/register", "arms.register"], ["/arms/12/retire", "arms.retire"], ["/validate", "arms.validate"], ["/data/refresh", "data.refresh"], ["/weird", "engine.weird"]])("%s -> %s", (p, n) => expect(engineToolName(p)).toBe(n));
});
