// P2–P3 of docs/prompt-agent-interpreter-plan.md: Reader, slots, rendering, critic, coverage, dry run.
import { describe, expect, it, vi } from "vitest";
import type { ScreenProgram } from "spec";
import { compileProgram } from "@/server/compiler/v5/compileProgram";
import { makeReader } from "@/server/compiler/v5/reader";
import { interpret } from "@/server/compiler/v5/interpret";
import { makeModelCritic, ruleCritic } from "@/server/compiler/v5/critic";
import { renderEnglish } from "@/server/compiler/v5/render";
import { toFiveSlots } from "@/server/compiler/v5/slots5";
import { coverage } from "@/server/compiler/v5/coverage";
import { dryRun, summariseDryRun } from "@/server/compiler/v5/dryRun";
import { preannotate } from "@/server/compiler/v5/preannotate";
import { normalise } from "@/server/compiler/v5/normalise";
import { segment } from "@/server/compiler/v5/segment";
import { NIFTY_PROCEDURAL } from "./procedural-p0.test";
import { SAMPLE } from "./samples";

const stage = (t: string, o: any = {}) => compileProgram(t, { ...o, resolve: false });
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

// an indirectly worded prompt no recogniser can read
const INDIRECT = `Nifty 100 stocks
Take the 6 day and 30 day simple averages of the close
Tell me when the faster one goes over the slower one`;
const cross = (over: Partial<any> = {}) => JSON.stringify({ conditions: [{
  kind: "condition", subject: "indicator", indicator: "sma", rhs_indicator: "sma", timeframe: null, op: "cross_above", direction: null,
  args: [{ name: "length", value: 6, phrase: "6" }, { name: "rhs.length", value: 30, phrase: "30" }], phrase: "goes over the slower one", ...over }] });

describe("pre-annotation", () => {
  it("tags numbers, timeframes and knowledge-repository hits with exact spans, no model", () => {
    const norm = normalise(NIFTY_PROCEDURAL);
    const ann = preannotate(norm, segment(norm));
    expect(ann.filter((a) => a.type === "number").map((a: any) => a.value)).toEqual([100, 6, 30]);
    expect(ann.some((a: any) => a.type === "kb" && a.id === "nifty_100")).toBe(true);
    expect(ann.some((a: any) => a.type === "timeframe" && a.value === "1D")).toBe(true);
    for (const a of ann) expect(norm.slice(a.span[0], a.span[1]).toLowerCase()).toBe(a.text.toLowerCase());
  });
});

describe("Reader (step 2) — whole prompt, verified", () => {
  it("links lines the tools cannot read into one cross condition, with spans on the lines the numbers came from", async () => {
    const callModel = vi.fn().mockResolvedValue(cross());
    const d = await stage(INDIRECT, { reader: makeReader(callModel) });
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(d.program.conditions[0]).toMatchObject({ lhs: { ind: "sma", params: { length: 6 } }, op: "cross_above", rhs: { ind: "sma", params: { length: 30 } } });
    expect(d.program.unrecognised).toEqual([]);
    expect(d.clauses[2].maps_to).toMatch(/read by the local model/);
    expect(d.clauses[1].maps_to).toMatch(/read together with line L3/);
    expect(d.reader?.dropped).toEqual([]);
  });

  it("the prompt it sends lists the unresolved lines and what is already understood", async () => {
    const callModel = vi.fn().mockResolvedValue(JSON.stringify({ conditions: [] }));
    await stage(INDIRECT, { reader: makeReader(callModel) });
    const [system, user] = callModel.mock.calls[0];
    expect(user).toContain("UNRESOLVED lines: L2, L3");
    expect(user).toContain("universe nifty_100");
    expect(system).toMatch(/Never invent/);
  });

  it("an invented value is dropped and reported, never compiled", async () => {
    const bad = cross({ args: [{ name: "length", value: 7, phrase: "6" }, { name: "rhs.length", value: 30, phrase: "30" }] });
    const d = await stage(INDIRECT, { reader: makeReader(vi.fn().mockResolvedValue(bad)) });
    expect(d.program.conditions).toEqual([]);
    expect(d.reader!.dropped.join()).toMatch(/cannot be read/);
    expect(d.clauses.some((c) => c.status === "not_understood")).toBe(true);
  });

  it("a phrase that is not in the prompt is dropped", async () => {
    const d = await stage(INDIRECT, { reader: makeReader(vi.fn().mockResolvedValue(cross({ phrase: "when the moon rises" }))) });
    expect(d.program.conditions).toEqual([]);
  });

  it("it cannot override a line the tools already read", async () => {
    const callModel = vi.fn().mockResolvedValue(cross({ phrase: "Nifty 100 stocks" }));
    const d = await stage(INDIRECT, { reader: makeReader(callModel) });
    expect(d.program.conditions).toEqual([]);
    expect(d.reader!.dropped.join()).toMatch(/not on an unresolved line/);
  });

  it("is never called when the tools read every line", async () => {
    const callModel = vi.fn();
    await stage(NIFTY_PROCEDURAL, { reader: makeReader(callModel) });
    expect(callModel).not.toHaveBeenCalled();
  });
});

describe("rendered English (§3.2)", () => {
  it("says exactly what will run", async () => {
    const d = await stage(NIFTY_PROCEDURAL);
    expect(renderEnglish(d.program)).toBe("From **NIFTY 100** stocks, on **daily** candles, find stocks where **SMA(6) crossed SMA(30) in either direction (bullish or bearish)**. Rank them by **event (crossover/flip) date**, newest first.");
  });
});

describe("five slots (§1)", () => {
  it("each slot is filled with where it came from; common values are suggestions only", async () => {
    const { program } = await compileProgram(NIFTY_PROCEDURAL);
    const s = toFiveSlots(program).conditions[0];
    expect(s.parameter.params.find((p) => p.name === "length")).toMatchObject({ value: 6, status: "from_prompt", suggestions: [] });
    expect(s.parameter.params.find((p) => p.name === "source")).toMatchObject({ value: "close", status: "assumed", suggestions: ["close"] });
    expect(s.operator).toMatchObject({ label: "cross_any", status: "derived" });
    expect(s.value.label).toMatch(/other series/);
    expect(s.trigger).toMatchObject({ within_bars: 1, status: "derived" });
    expect(s.data_range).toMatchObject({ timeframe: "1D", min_bars: 31, status: "from_prompt" });
    expect(toFiveSlots(program).rank[0]).toMatchObject({ key: "C1.event_date", order: "desc", status: "from_prompt" });
  });

  it("an unknown parameter leaves the data range pending rather than guessed", async () => {
    const { program } = await stage("Weekly\nRSI above 60");
    expect(toFiveSlots(program).conditions[0].data_range.min_bars).toBeNull();
    expect(toFiveSlots(program).conditions[0].parameter.params.find((p) => p.name === "length")).toMatchObject({ status: "missing", suggestions: [7, 14, 21] });
  });
});

describe("coverage (§3 step 5)", () => {
  it("every line is used, ignored with a reason, or flagged", async () => {
    const c = coverage((await stage(NIFTY_PROCEDURAL)).clauses);
    expect(c.unaccounted).toEqual([]);
    expect(c.flagged).toEqual([]);
    expect(c.ignored.map((x) => x.id)).toEqual(["L2"]);
    const f = coverage((await stage("Nifty 100\nthe moon is in the seventh house")).clauses);
    expect(f.flagged.map((x) => x.id)).toEqual(["L2"]);
  });
});

describe("critic (§3 step 6)", () => {
  it("a clean reading has no issues", async () => {
    const d = await stage(NIFTY_PROCEDURAL);
    expect(ruleCritic(d.normalised, d.clauses, d.program)).toEqual([]);
    const s = await stage(SAMPLE);
    expect(ruleCritic(s.normalised, s.clauses, s.program)).toEqual([]);
  });

  it("model critic: issues must be quotable from the prompt, others are dropped", async () => {
    const out = JSON.stringify({ issues: [{ kind: "reversed", phrase: "bullish and bearish", note: "x" }, { kind: "extra", phrase: "something never said", note: "y" }] });
    const issues = await makeModelCritic(vi.fn().mockResolvedValue(out))(normalise(NIFTY_PROCEDURAL), "reading");
    expect(issues.map((i) => i.phrase)).toEqual(["bullish and bearish"]);
    expect(await makeModelCritic(vi.fn().mockResolvedValue("not json"))("p", "r")).toEqual([]);
  });

  // seeded wrong programs: direction flipped, condition dropped, value changed, comparator flipped, rank reversed
  const PROMPTS = [NIFTY_PROCEDURAL, NIFTY_PROCEDURAL.replace("bullish and bearish", "bullish"), NIFTY_PROCEDURAL.replace("bullish and bearish", "bearish"),
    SAMPLE, "All stocks between 10K-50K cr\nWeekly\nRSI(14) above 60", "All stocks below 10K cr market cap\nDaily\nRSI(14) below 30\nVStop 10,2 flipped",
    "All stocks between 10K-50K cr\nWeekly\nflipped on VStop 10,2\nRSI Range 50 to 65\nRank by most recent crossover date first"];
  it("catches ≥ 90% of seeded errors", async () => {
    let seeded = 0, caught = 0;
    for (const t of PROMPTS) {
      const d = await stage(t);
      const mutants: ScreenProgram[] = [];
      d.program.conditions.forEach((c, i) => {
        const dropped = clone(d.program); dropped.conditions.splice(i, 1); mutants.push(dropped);
        if (Array.isArray(c.value) && typeof c.value[1] === "number") { const m = clone(d.program); (m.conditions[i].value as number[])[1] += 7; mutants.push(m); }
        if (c.op === "<" || c.op === ">") { const m = clone(d.program); m.conditions[i].op = c.op === "<" ? ">" : "<"; mutants.push(m); }
        if (c.op === "cross_any" || c.op === "cross_above" || c.op === "cross_below") { const m = clone(d.program); m.conditions[i].op = c.op === "cross_above" ? "cross_below" : "cross_above"; mutants.push(m); }
        if (c.op === "flip") { const m = clone(d.program); (m.conditions[i] as any).dir = "short"; mutants.push(m); }
      });
      const rank = d.program.actions.findIndex((a: any) => a.type === "rank");
      if (rank >= 0) { const m = clone(d.program); (m.actions[rank] as any).by[0].order = "asc"; mutants.push(m); }
      for (const m of mutants) { seeded++; if (ruleCritic(d.normalised, d.clauses, m).length > 0) caught++; }
    }
    expect(seeded).toBeGreaterThanOrEqual(20);
    expect(caught / seeded).toBeGreaterThanOrEqual(0.9);
  });
});

describe("dry run (§3 step 7)", () => {
  it("summarises counts and warns on 0 or all matches; never throws", async () => {
    const { program } = await compileProgram(NIFTY_PROCEDURAL);
    const ok = summariseDryRun({ sets: [{ id: "S1", count: 4 }], universe_count: 100 }, program, "2026-10-07");
    expect(ok).toMatchObject({ ok: true, counts: [{ id: "S1", count: 4 }], warnings: [] });
    expect(summariseDryRun({ sets: [{ id: "S1", count: 0 }] }, program, "d").warnings[0]).toMatch(/matched no stocks/);
    expect(summariseDryRun({ sets: { S1: 100 }, universe_count: 100, data_gaps: ["INFY"] }, program, "d").warnings.join()).toMatch(/every stock.*data gap: INFY/);
    expect(summariseDryRun({}, program, "d").ok).toBe(false);
    const down = await dryRun(program, "2026-10-07", async () => { throw new Error("engine down"); });
    expect(down).toMatchObject({ ok: false, warnings: ["dry run unavailable: engine down"] });
  });
});

describe("interpret() end to end", () => {
  it("the procedural prompt needs no model, no issues, one round", async () => {
    const r = await interpret(NIFTY_PROCEDURAL, { dryRun: { asOf: "2026-10-07", screen: async () => ({ sets: [{ id: "S1", count: 3 }], universe_count: 100 }) } });
    expect(r.issues).toEqual([]);
    expect(r.rounds).toBe(0);
    expect(r.reader.calls).toBe(0);
    expect(r.program.needs_input).toEqual([]);
    expect(r.dryRun!.counts[0].count).toBe(3);
    expect(r.english).toMatch(/NIFTY 100/);
  });

  it("an indirect prompt is read by the Reader, once, and the critic's surviving issue lands on its line", async () => {
    const reader = makeReader(vi.fn().mockResolvedValue(cross()));
    const critic = makeModelCritic(vi.fn().mockResolvedValue(JSON.stringify({ issues: [{ kind: "reversed", phrase: "goes over the slower one", note: "check direction" }] })));
    const r = await interpret(INDIRECT, { reader, critic });
    expect(r.program.conditions).toHaveLength(1);
    expect(r.issues).toHaveLength(1);
    expect(r.clauses.find((c) => c.text.includes("goes over"))!.maps_to).toMatch(/⚠ reversed: check direction/);
  });

  it("the critic's issues go back to the Reader for a second reading when a line is still unread (max 2 rounds)", async () => {
    const callModel = vi.fn().mockResolvedValueOnce(JSON.stringify({ conditions: [] })).mockResolvedValue(cross());
    const critic = vi.fn().mockResolvedValue([{ kind: "missing", phrase: "goes over the slower one", note: "no rule reads this line", source: "model" }]);
    const r = await interpret(INDIRECT, { reader: makeReader(callModel), critic, maxRounds: 2 });
    expect(r.rounds).toBeGreaterThanOrEqual(1);
    expect(r.program.conditions).toHaveLength(1);
    expect(callModel.mock.calls.some((c) => /reviewer found these problems/.test(c[1]))).toBe(true);
    expect(callModel.mock.calls.length).toBeLessThanOrEqual(6);
  });
});

describe("Reader schema", () => {
  it("requires rhs_indicator, so a model cannot silently omit the second series", async () => {
    const { READER_JSON_SCHEMA } = await import("@/server/compiler/v5/reader");
    const item = (READER_JSON_SCHEMA as any).properties.conditions.items;
    expect(item.required).toContain("rhs_indicator");
  });
});
