import { describe, expect, it } from "vitest";
import { compileProgram } from "@/server/compiler/v5/compileProgram";
import { applyChipEdit } from "@/server/compiler/v5/resolve";
import { toSlotConditions } from "@/server/compiler/v5/slots";
import { programConfirmProblems } from "@/server/compiler/v5/answer";
import { forEngine } from "@/server/engine/client";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { BUILTIN_DEFAULTS, getUserDefaults, setUserDefaults } from "@/server/userDefaults";

const SIX_LINES = [
  "All stocks below 10K cr Market Cap", "flipped on VStop 10,2", "RSI Range 50 to 65",
  "Group qualified stocks by sectors and highlight the Outperforming sectors",
  "From stocks flipped on VStop 10,2 build a strategy with SL and EP and confidence on that trade",
  "Backtest and validate with same strategy on previous week data and validate with their returns in this week",
].join("\n");

const chip = (p: any, path: string) => p.assumptions?.find((a: any) => a.path === path);

describe("interpreter §9.1 — 'All stocks below 10K cr Market Cap'", () => {
  it("runs with no questions, no actions, one rule", async () => {
    const { program: p } = await compileProgram("All stocks below 10K cr Market Cap");
    expect(p.needs_input).toEqual([]);
    expect(programConfirmProblems(p)).toEqual([]);
    expect(p.actions).toEqual([]);
    expect(p.conditions).toMatchObject([{ id: "C1", lhs: { field: "mcap_cr" }, op: "<", value: 10000 }]);
    expect(p.universe).toEqual({ source: "nse_all" });
  });
});

describe("interpreter §9.2 — the full six-line prompt", () => {
  it("resolves every open slot into a chip, asks nothing, and leaves nothing for the engine to refuse", async () => {
    const { program: p, clauses } = await compileProgram(SIX_LINES);
    expect(p.needs_input).toEqual([]);
    expect(p.unrecognised).toEqual([]);
    expect(programConfirmProblems(p)).toEqual([]);
    expect(clauses.every((c) => c.questions === 0 && c.status === "ok")).toBe(true);

    // C2 VStop(10,2): source and timeframe come from the saved defaults
    expect(chip(p, "conditions.C2.params.source")).toMatchObject({ value: "close", provenance: "assumed" });
    expect(chip(p, "conditions.C2.tf")).toMatchObject({ value: "1W", provenance: "assumed" });
    // C3 RSI: length is the indicator's standard 14; weekly is inferred from C2
    expect(chip(p, "conditions.C3.params.length")).toMatchObject({ value: 14, provenance: "assumed" });
    expect(chip(p, "conditions.C3.tf")).toMatchObject({ value: "1W", provenance: "inferred" });
    // A1 / A2 / A3 defaults
    expect(chip(p, "actions.A1.highlight.metric")).toMatchObject({ value: "sector_return_vs_benchmark" });
    expect(chip(p, "actions.A2.entry.at")).toMatchObject({ value: "next_open" });
    expect(chip(p, "actions.A2.confidence.method")).toMatchObject({ value: "rsi_band_and_stop_distance" });
    expect(chip(p, "actions.A3.horizons_w")).toMatchObject({ value: [1, 2, 3] });
    // literal scope: the trade plan is on the VStop-flipped set only; the wider set is one chip option away
    expect(p.actions[1]).toMatchObject({ type: "trade_plan", set: "S3", stop: { from: "C2" } });
    expect(chip(p, "actions.A2.set").options.map((o: any) => o.value)).toEqual(["S3", "S2"]);
    // the engine sees the rules only
    expect(Object.keys(forEngine(p))).not.toContain("assumptions");
    expect(Object.keys(forEngine(p))).not.toContain("not_evaluable");
  });

  it("stores every condition as the 4-slot JSON with a provenance per slot", async () => {
    const { program: p } = await compileProgram(SIX_LINES);
    const slots = toSlotConditions(p, BUILTIN_DEFAULTS);
    expect(slots.find((s) => s.id === "C2")).toMatchObject({
      source_text: "flipped on VStop 10,2",
      parameter: { name: "vstop", args: { length: 10, mult: 2 }, source: "close", timeframe: "1W" },
      operator: "flips_long", value: null,
      trigger: { timeframe: "1W", bar: "last_closed", evaluate_at: "friday_close", recheck_at: "monday_open", lookback_bars: 1 },
      provenance: { "parameter.name": "stated", "parameter.args": "stated", "parameter.source": "assumed", "parameter.timeframe": "assumed", operator: "stated", value: "n/a", trigger: "assumed" },
      evaluable: true, not_evaluable_reason: null,
    });
    expect(slots.find((s) => s.id === "C3")).toMatchObject({
      parameter: { name: "rsi", args: { length: 14 }, timeframe: "1W" }, operator: "between", value: [50, 65],
      provenance: { "parameter.args": "assumed", "parameter.timeframe": "inferred", value: "stated" },
    });
    expect(slots.find((s) => s.id === "C1")).toMatchObject({ parameter: { name: "mcap_cr" }, operator: "<", value: 10000, provenance: { "parameter.timeframe": "n/a" } });
  });
});

describe("saved user defaults are read from storage, not hard-coded", () => {
  it("a user's saved timeframe, price source, entry and horizons drive the fill", async () => {
    const raw = createTestDb();
    const userId = ensureOwnerUser(raw);
    expect(getUserDefaults(raw, userId)).toEqual(BUILTIN_DEFAULTS);
    const saved = setUserDefaults(raw, userId, { timeframe: "1D", price_source: "open", entry_recheck: "friday_close", horizons_weeks: [2, 4] });
    expect(getUserDefaults(raw, userId)).toEqual(saved);
    const { program: p } = await compileProgram(SIX_LINES, { defaults: getUserDefaults(raw, userId) });
    expect(chip(p, "conditions.C2.params.source").value).toBe("open");
    expect(chip(p, "conditions.C2.tf").value).toBe("1D");
    expect(chip(p, "actions.A2.entry.at").value).toBe("signal_close");
    expect(chip(p, "actions.A3.horizons_w").value).toEqual([2, 4]);
  });
  it("rejects a nonsense default", () => {
    const raw = createTestDb();
    expect(() => setUserDefaults(raw, ensureOwnerUser(raw), { timeframe: "2W" as any })).toThrow(/timeframe/);
  });
});

describe("a condition that cannot be evaluated is greyed out and the rest runs (§4.2)", () => {
  it("a placeholder bound ('RSI Range X to Y') drops only that rule, with a reason, and asks nothing", async () => {
    const { program: p } = await compileProgram("All stocks below 10K cr Market Cap\nWeekly\nRSI(14) Range X to Y");
    expect(p.needs_input).toEqual([]);
    expect(p.conditions.map((c) => c.id)).toEqual(["C1"]);
    expect(p.not_evaluable).toMatchObject([{ id: "C2", reason: expect.stringContaining('"X"'), condition: { id: "C2" } }]);
    expect(p.sets.every((s) => !JSON.stringify(s.where).includes("C2"))).toBe(true);
    expect(programConfirmProblems(p)).toEqual([]);
    expect(toSlotConditions(p, BUILTIN_DEFAULTS).find((s) => s.id === "C2")).toMatchObject({ evaluable: false, not_evaluable_reason: expect.any(String) });
  });
  it("a line nothing recognises is reported, not blocking", async () => {
    const { program: p, clauses } = await compileProgram("All stocks below 10K cr Market Cap\nthe moon is in the seventh house");
    expect(p.unrecognised).toEqual([]);
    expect(p.not_evaluable).toMatchObject([{ text: "the moon is in the seventh house" }]);
    expect(clauses[1]).toMatchObject({ status: "not_understood", questions: 0 });
    expect(programConfirmProblems(p)).toEqual([]);
  });
  it("only a prompt with no rule at all cannot run", async () => {
    const { program: p } = await compileProgram("the moon is in the seventh house");
    expect(programConfirmProblems(p)).toEqual(["no part of the prompt could be turned into a rule to screen on"]);
  });
});

describe("editing a chip", () => {
  it("replaces the assumed value with the user's, which stays as an 'edited' chip so it can be changed again", async () => {
    const { program: p } = await compileProgram(SIX_LINES);
    const q = applyChipEdit(p, "conditions.C3.params.length", 21, BUILTIN_DEFAULTS);
    expect((q.conditions.find((c) => c.id === "C3")!.lhs as any).params.length).toBe(21);
    expect(chip(q, "conditions.C3.params.length")).toMatchObject({ value: 21, provenance: "edited" });
    expect(chip(q, "conditions.C3.params.length")!.label).not.toMatch(/\b14\b/);
    const again = applyChipEdit(q, "conditions.C3.params.length", 34, BUILTIN_DEFAULTS);   // editable a second time
    expect((again.conditions.find((c) => c.id === "C3")!.lhs as any).params.length).toBe(34);
    expect(chip(again, "conditions.C3.params.length")).toMatchObject({ value: 34, provenance: "edited" });
    expect(q.answers).toContainEqual({ path: "conditions.C3.params.length" });
    expect(q.needs_input).toEqual([]);
  });
  it("rejects a value the registry does not allow and leaves the program as it was", async () => {
    const { program: p } = await compileProgram(SIX_LINES);
    expect(() => applyChipEdit(p, "conditions.C3.params.length", -3, BUILTIN_DEFAULTS)).toThrow();
    expect(() => applyChipEdit(p, "conditions.C1.value", 5, BUILTIN_DEFAULTS)).toThrow(/no assumed value/);
  });
  it("switching the outperformance metric re-resolves its own settings instead of asking for them", async () => {
    const { program: p } = await compileProgram(SIX_LINES);
    const q = applyChipEdit(p, "actions.A1.highlight.metric", "median_return_of_qualifiers", BUILTIN_DEFAULTS);
    expect(q.needs_input).toEqual([]);
    expect(q.actions[0]).toMatchObject({ highlight: { metric: "median_return_of_qualifiers", rule: { top_k: 3 } } });
    expect(chip(q, "actions.A1.highlight.rule.rs_gt")).toBeUndefined();   // belonged to the old metric
    expect(chip(q, "actions.A1.highlight.rule.top_k")).toMatchObject({ value: 3 });
  });
  it("picking the wider scope for the trade plan is one chip edit", async () => {
    const { program: p } = await compileProgram(SIX_LINES);
    const q = applyChipEdit(p, "actions.A2.set", "S2", BUILTIN_DEFAULTS);
    expect(q.actions[1]).toMatchObject({ set: "S2" });
  });
});

describe("settings route", () => {
  it("round-trips saved defaults for the current user", async () => {
    const { vi } = await import("vitest");
    const raw = createTestDb();
    ensureOwnerUser(raw);
    vi.doMock("@/server/db/client", () => ({ db: () => raw }));
    const { GET, PUT } = await import("../../app/api/settings/defaults/route");
    const put = await PUT(new Request("http://x", { method: "PUT", body: JSON.stringify({ timeframe: "1D", horizons_weeks: [1, 4] }) }));
    expect(await put.clone().json()).not.toHaveProperty("error");
    expect(put.status).toBe(200);
    const got = await (await GET(new Request("http://x"))).json();
    expect(got).toMatchObject({ timeframe: "1D", horizons_weeks: [1, 4], price_source: "close" });
    expect((await PUT(new Request("http://x", { method: "PUT", body: JSON.stringify({ timeframe: "2W" }) }))).status).toBe(400);
  });
});
