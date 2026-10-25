import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { createDraft, getDraft, updateDraft } from "@/server/drafts";
import { compileProgramDraft, editChip, editProgramClause, screenProgramDraft, setAddon } from "@/server/compileProgramDraft";
import { SAMPLE } from "./samples";

let raw = await createTestDb();
vi.mock("@/server/db/client", () => ({ db: () => raw }));
import { PATCH as patchDraftRoute } from "@/../app/api/drafts/[draftId]/route";
import { POST as answerRoute } from "@/../app/api/drafts/[draftId]/program/answer/route";
import { POST as compileRoute, GET as viewRoute } from "@/../app/api/drafts/[draftId]/program/route";

async function fresh(text = SAMPLE) {
  raw = await createTestDb();
  const { draftId } = await createDraft(raw, { userId: await ensureOwnerUser(raw) });
  await updateDraft(raw, draftId, { promptText: text });
  return draftId;
}
const ctx = (id: number) => ({ params: { draftId: String(id) } });
const post = (body: unknown) => new Request("http://x", { method: "POST", body: JSON.stringify(body) });

const INDIRECT = `Nifty 100 stocks
Take the 6 day and 30 day simple averages of the close
Tell me when the faster one goes over the slower one`;

describe("compileProgramDraft deadline (a Netlify function is cut off at 60 s)", () => {
  it("stops waiting on a model that never answers and returns the rules' reading instead of hanging", async () => {
    const id = await fresh(INDIRECT);
    const hang = vi.fn(() => new Promise<string>(() => {}));
    const started = Date.now();
    const v = await compileProgramDraft(raw, id, { callModel: hang as any, deadlineMs: 150 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(hang).toHaveBeenCalled();
    expect(v.program).toBeTruthy();
    expect(v.clauses.length).toBeGreaterThan(0);
  }, 10_000);

  it("a model that answers in time is unaffected by the deadline", async () => {
    const id = await fresh(SAMPLE);
    const callModel = vi.fn();
    const v = await compileProgramDraft(raw, id, { callModel, deadlineMs: 5000 });
    expect(callModel).not.toHaveBeenCalled();
    expect(v.ready).toBe(true);
  });
});

describe("compileProgramDraft", () => {
  it("compiles the sample prompt with zero model calls, zero questions, and persists the resolved program", async () => {
    const id = await fresh();
    const callModel = vi.fn();
    const v = await compileProgramDraft(raw, id, { callModel });
    expect(callModel).not.toHaveBeenCalled();
    expect(v).not.toHaveProperty("questions");
    expect(v.program.needs_input).toEqual([]);
    expect(v.ready).toBe(true);
    expect(v.chips.length).toBeGreaterThan(0);
    expect(v.conditions.map((c) => c.id)).toEqual(["C1", "C2", "C3"]);
    const d = (await getDraft(raw, id))!;
    expect(d.program!.sets).toHaveLength(3);
    expect(d.programClauses).toHaveLength(7);
    expect(d.programClauses!.every((c) => c.questions === 0)).toBe(true);
    expect(d.programNormalised).toContain("strategy");   // "stratergy" normalised
  });

  it("a chip edit changes one assumed value, keeps the rest, and survives a reload", async () => {
    const id = await fresh();
    await compileProgramDraft(raw, id, { useModel: false });
    const v = await editChip(raw, id, "conditions.C3.params.length", 21);
    expect((v.program.conditions[2].lhs as any).params.length).toBe(21);
    expect(v.chips.find((c) => c.path === "conditions.C3.params.length")).toMatchObject({ value: 21, provenance: "edited" });
    expect(v.chips.some((c) => c.path === "conditions.C2.params.source")).toBe(true);
    expect((await getDraft(raw, id))!.program!.conditions[2].lhs).toMatchObject({ params: { length: 21 } });
  });

  it("rejects a bad chip edit with a plain error and leaves the draft untouched", async () => {
    const id = await fresh();
    await compileProgramDraft(raw, id, { useModel: false });
    const before = (await getDraft(raw, id))!.program;
    await expect(editChip(raw, id, "conditions.C3.params.length", 1)).rejects.toThrow(/between 2 and 100/);
    expect((await getDraft(raw, id))!.program).toEqual(before);
  });

  it("add-ons are off until switched on, and switching one on adds an ordinary rule", async () => {
    const id = await fresh();
    const v0 = await compileProgramDraft(raw, id, { useModel: false });
    expect(v0.addons).toMatchObject({ liquidity: { enabled: false }, min_price: { enabled: false }, asm_gsm: { enabled: false, available: false } });
    expect(v0.program.conditions).toHaveLength(3);
    const v1 = await setAddon(raw, id, { liquidity: { mode: "floor", cr: 10 } });
    expect(v1.addons.liquidity).toMatchObject({ enabled: true, cr: 10 });
    expect(v1.program.conditions).toHaveLength(4);
    const v2 = await setAddon(raw, id, { min_price: { mode: "floor", price: 50 } });
    expect(v2.addons.min_price).toMatchObject({ enabled: true, price: 50 });
    const v3 = await setAddon(raw, id, { liquidity: { mode: "none" } });
    expect(v3.addons.liquidity.enabled).toBe(false);
    expect(v3.addons.min_price.enabled).toBe(true);   // switching one off leaves the other alone
  });

  it("runs the screen immediately (no answers needed) and sends the engine only the rules", async () => {
    const id = await fresh();
    await compileProgramDraft(raw, id, { useModel: false });
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ funnel: [], sets: {} }) });
    await expect(screenProgramDraft(raw, id, "2026-08-03", fetchFn as any)).resolves.toEqual({ funnel: [], sets: {} });
    const sent = JSON.parse(fetchFn.mock.calls[0][1].body);
    expect(fetchFn.mock.calls[0][0]).toMatch(/\/screen\/v5$/);
    expect(sent.as_of).toBe("2026-08-03");
    expect(sent.program.needs_input).toEqual([]);
    expect(sent.program.unrecognised).toEqual([]);
    expect(sent.program).not.toHaveProperty("assumptions");
    expect(sent.program).not.toHaveProperty("not_evaluable");
  });

  it("asks the engine for the full list of stocks only when told to", async () => {
    const id = await fresh();
    await compileProgramDraft(raw, id, { useModel: false });
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ sets: {} }) });
    await screenProgramDraft(raw, id, "2026-08-03", fetchFn as any);
    await screenProgramDraft(raw, id, "2026-08-03", fetchFn as any, true);
    const bodies = fetchFn.mock.calls.map((c) => JSON.parse(c[1].body));
    expect(bodies[0]).not.toHaveProperty("table");
    expect(bodies[1].table).toBe(true);
  });

  it("editing a line rewrites just that line and recompiles; earlier chip edits are dropped", async () => {
    const id = await fresh();
    await compileProgramDraft(raw, id, { useModel: false });
    await editChip(raw, id, "conditions.C3.params.length", 21);
    const v = await editProgramClause(raw, id, "L4", "RSI Range 40 to 70", { useModel: false });
    expect(v.program.conditions[2].value).toEqual([40, 70]);
    expect((v.program.conditions[2].lhs as any).params.length).toBe(14);
    expect(v.program.conditions[1].lhs).toMatchObject({ params: { length: 10, mult: 2 } });
  });

  it("a not-understood line is greyed out with a reason and the program is still ready", async () => {
    const id = await fresh("All stocks between 10K-50K cr\nthe moon is in the seventh house");
    const v = await compileProgramDraft(raw, id, { useModel: false });
    expect(v.clauses[1].status).toBe("not_understood");
    expect(v.notEvaluable).toMatchObject([{ text: "the moon is in the seventh house" }]);
    expect(v.problems).toEqual([]);
    expect(v.ready).toBe(true);
  });
});

describe("routes", () => {
  it("compile -> view -> chip edit round trip; program columns can't be forged through the generic PATCH", async () => {
    const id = await fresh();
    const c = await compileRoute(post({}), ctx(id));
    expect(c.status).toBe(200);
    const view = await (await viewRoute(post({}), ctx(id))).json();
    expect(view.questions).toBeUndefined();
    expect(view.ready).toBe(true);
    const nChips = view.chips.length;
    const bad = await answerRoute(post({ path: "conditions.C3.params.length", value: 1 }), ctx(id));
    expect(bad.status).toBe(400);
    const good = await answerRoute(post({ path: "conditions.C3.params.length", value: 21 }), ctx(id));
    expect(good.status).toBe(200);
    expect((await good.json()).chips).toHaveLength(nChips);
    const addon = await answerRoute(post({ liquidity: { mode: "floor", cr: 10 } }), ctx(id));
    expect((await addon.json()).addons.liquidity.enabled).toBe(true);
    const forged = JSON.stringify({ needs_input: [] });
    const res = await patchDraftRoute(new Request("http://x", { method: "PATCH", body: JSON.stringify({ programJson: forged, programClausesJson: "[]", programNormalised: "x" }) }), ctx(id));
    expect(res.status).toBe(200);
    expect((await getDraft(raw, id))!.program!.conditions.length).toBe(4);
  });

  it("rejects malformed bodies", async () => {
    const id = await fresh();
    await compileRoute(post({}), ctx(id));
    expect((await answerRoute(post({ nope: 1 }), ctx(id))).status).toBe(400);
    expect((await answerRoute(post({ path: "conditions.C2.params.__proto__", value: 1 }), ctx(id))).status).toBe(400);
  });
});

describe("momentum prompt with a pasted return formula", () => {
  const plain = "Rank Nifty 200 by 12-month return excluding the most recent month and give me the top 20";
  const withFormula = "Rank Nifty 200 by 12-month return (day n price - day0 price)*100/day0_price excluding the most recent month and give me the top 20 based on returns";
  it("reads the formula as part of the momentum rule instead of dropping every rule", async () => {
    const { compileProgram } = await import("@/server/compiler/v5/compileProgram");
    for (const text of [plain, withFormula]) {
      const d = await compileProgram(text, {});
      expect(d.program.conditions.map((c: any) => c.lhs.ind)).toEqual(["momentum_skip"]);
      expect(d.program.actions.map((a: any) => a.type)).toEqual(["rank", "limit"]);
      expect(d.program.not_evaluable ?? []).toEqual([]);
    }
  });
});

describe("momentum chips can be edited repeatedly and each Apply re-resolves the rule", () => {
  it("lookback, skip and cut-off all change, and stay editable", async () => {
    raw = await createTestDb();
    const { draftId } = await createDraft(raw, { userId: await ensureOwnerUser(raw) });
    await updateDraft(raw, draftId, { promptText: "Rank Nifty 200 by 12-month return (day n price - day0 price)*100/day0_price excluding the most recent month and give me the top 20 based on returns" });
    await compileProgramDraft(raw, draftId, { useModel: false });
    for (const [path, v] of [["conditions.C1.params.lookback", 126], ["conditions.C1.params.skip", 10], ["conditions.C1.value", 0], ["conditions.C1.params.lookback", 63]] as const) {
      const view = await editChip(raw, draftId, path, v);
      expect(view.chips.find((c) => c.path === path)).toMatchObject({ value: v, provenance: "edited" });
    }
    const c = (await getDraft(raw, draftId))!.program!.conditions[0] as any;
    expect([c.lhs.params.lookback, c.lhs.params.skip, c.value]).toEqual([63, 10, 0]);
  });
});
