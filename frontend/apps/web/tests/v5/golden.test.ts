import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compileProgram as resolvingCompile } from "@/server/compiler/v5/compileProgram";
// these tests are about the compiler stage itself, before the interpreter fills open slots (see interpreter.test.ts)
const compileProgram = (t: string, o: any = {}) => resolvingCompile(t, { ...o, resolve: false });
import { questionFor } from "@/server/compiler/v5/questions";
import { verifyProgram } from "@/server/compiler/v5/verify";
import type { ScreenProgram } from "spec";

import { SAMPLE } from "./samples";

const NUMBERED = `1. All stocks between 10K to 50K cr market cap
2. Weekly timeframe: VStop 10,2 flipped and RSI 50 to 65
3. Group stocks from 2 by sector and highlight the outperforming sectors
4. From stocks in 2 build a strategy with SL and EP and confidence
5. Backtest and validate on previous week data, returns in this week`;

const NIFTY = `Nifty 100 stocks from the official Nifty Indices CSV
On daily candles, find SMA 6 and SMA 30 bullish and bearish crossovers
Rank by most recent crossover date first`;

const hash = (p: ScreenProgram) => createHash("sha256").update(JSON.stringify(p)).digest("hex");
const paths = (p: ScreenProgram) => p.needs_input.map((n) => n.path);
const compile = (t: string) => compileProgram(t);

describe("sample prompt (07 Oct)", () => {
  it("compiles to the §2.1 IR: S1/S2/S3, 6 questions, 'in' ignored, zero model calls", async () => {
    let calls = 0;
    const d = await compileProgram(SAMPLE, { fallback: async () => { calls++; return []; } });
    const p = d.program;
    expect(calls).toBe(0);
    expect(p.universe).toEqual({ source: "nse_all" });
    expect(p.sets.map((s) => [s.id, s.from, s.where])).toEqual([
      ["S1", "universe", { all: ["C1"] }], ["S2", "S1", { all: ["C2", "C3"] }], ["S3", "S1", { all: ["C2"] }],
    ]);
    expect(p.sets[1].eval).toEqual({ mode: "literal", timeframe: "1W", bar: "last_completed" });
    expect(p.conditions[0]).toMatchObject({ id: "C1", lhs: { field: "mcap_cr" }, op: "between", value: [10000, 50000] });
    expect(p.conditions[1]).toMatchObject({ id: "C2", lhs: { ind: "vstop", params: { length: 10, mult: 2, source: null }, tf: "1W" }, op: "flip", dir: "long", within_bars: 1 });
    expect(p.conditions[2]).toMatchObject({ id: "C3", lhs: { ind: "rsi", params: { length: null }, tf: "1W" }, op: "between", value: [50, 65] });
    expect(p.actions[0]).toMatchObject({ type: "group_by", set: "S2", key: "sector", highlight: { metric: null, rule: null } });
    expect(p.actions[1]).toMatchObject({ type: "trade_plan", set: "S3", entry: { at: null }, stop: { from: "C2" }, confidence: { method: null } });
    expect(p.actions[2]).toMatchObject({ type: "validate", shift: { weeks: -1 }, horizons_w: null });   // "returns in this week" names no horizon: the saved horizons fill it
    expect(paths(p)).toEqual([
      "conditions.C2.params.source", "conditions.C3.params.length", "actions.A1.highlight.metric",
      "actions.A2.entry.at", "actions.A2.confidence.method", "actions.A2.set", "actions.A3.horizons_w",
    ]);
    const amb = p.needs_input.find((n) => n.path === "actions.A2.set")!;
    expect(amb.reason).toBe("ambiguous");
    expect(amb.options!.map((o) => o.value)).toEqual(["S3", "S2"]);
    expect(questionFor(amb, p)).toMatch(/flipped on VStop 10,2.*could mean.*\(a\).*\(b\)/);
    expect(p.ignored).toEqual([{ text: "in", reason: "stray word after a set reference" }]);
    expect(p.unrecognised).toEqual([]);
    expect(p.unsupported).toEqual([]);
  });

  it("interpretation view: every line mapped, the question counts match", async () => {
    const d = await compile(SAMPLE);
    expect(d.clauses.map((c) => [c.status, c.questions])).toEqual([
      ["ok", 0], ["ok", 0], ["question", 1], ["question", 1], ["question", 1], ["question", 3], ["question", 1],
    ]);
    expect(d.clauses[5].maps_to).toMatch(/A2: trade plan on S3/);
    expect(d.clauses[0].maps_to).toMatch(/Market cap between 10,000–50,000 cr/);
  });
});

describe("golden set", () => {
  it("1a numbered brief: 'from 2' references resolve by number, no scope ambiguity", async () => {
    const p = (await compile(NUMBERED)).program;
    expect(p.sets.map((s) => s.where)).toEqual([{ all: ["C1"] }, { all: ["C2", "C3"] }]);
    expect(p.actions.map((a: any) => [a.type, a.set])).toEqual([["group_by", "S2"], ["trade_plan", "S2"], ["validate", undefined]]);
    expect(paths(p)).toEqual(["conditions.C2.params.source", "conditions.C3.params.length", "actions.A1.highlight.metric", "actions.A2.entry.at", "actions.A2.confidence.method", "actions.A3.horizons_w"]);
  });

  it("1b placeholders: 'RSI Range X to Y' -> two placeholder questions, no numbers in the IR", async () => {
    const p = (await compile("All stocks between 10K-50K cr market cap\nWeekly timeframe\nRSI Range X to Y")).program;
    const rsi = p.conditions[1];
    expect(rsi.value).toEqual([null, null]);
    expect(p.needs_input.filter((n) => n.reason === "placeholder").map((n) => [n.path, n.token])).toEqual([["conditions.C2.value.0", "X"], ["conditions.C2.value.1", "Y"]]);
    expect(questionFor(p.needs_input.find((n) => n.path.endsWith("value.0"))!, p)).toBe('You wrote "X". What is the lower bound of the RSI range?');
    expect(p.source_phrases.some((s) => s.path.startsWith("conditions.C2.value"))).toBe(false);
  });

  it("2 Nifty 100 SMA crossover: index universe, daily, indicator-vs-indicator, rank — no model call", async () => {
    const p = (await compile(NIFTY)).program;
    expect(p.universe).toEqual({ source: "index", index: "NIFTY 100", list: "niftyindices_csv" });
    expect(p.conditions[0]).toMatchObject({ lhs: { ind: "sma", params: { length: 6, source: null }, tf: "1D" }, op: "cross_any", rhs: { ind: "sma", params: { length: 30, source: null }, tf: "1D" }, within_bars: null });
    expect(p.conditions[0].emit).toEqual(["direction", "event_date"]);
    expect(p.actions[0]).toMatchObject({ type: "rank", set: "S1", by: [{ key: "C1.event_date", order: "desc" }] });
    expect(paths(p)).toEqual(["conditions.C1.params.source", "conditions.C1.rhs.params.source"]);
  });

  it("3 identical prompt -> identical program hash, 10 runs in a row", async () => {
    const hashes = new Set<string>();
    for (let i = 0; i < 10; i++) hashes.add(hash((await compile(NIFTY)).program));
    expect(hashes.size).toBe(1);
  });

  it("4 universe filter only: a program with zero signal conditions is valid", async () => {
    const p = (await compile("All stocks between 10K-50K cr")).program;
    expect(p.conditions).toHaveLength(1);
    expect(p.sets.map((s) => s.where)).toEqual([{ all: ["C1"] }]);
    expect(p.needs_input).toEqual([]);
  });

  it("5 one-sided cap: exactly one condition mcap_cr < 10000, double spaces normalised, no questions", async () => {
    const p = (await compile("All stocks below  10K cr Market Cap")).program;
    expect(p.conditions).toHaveLength(1);
    expect(p.conditions[0]).toMatchObject({ lhs: { field: "mcap_cr" }, op: "<", value: 10000 });
    expect(p.needs_input).toEqual([]);
  });

  it("5b contradiction: 'below 10K-50K cr' -> one question, three options built from the user's own numbers", async () => {
    const p = (await compile("All stocks below 10K-50K cr Market Cap")).program;
    expect(p.needs_input).toHaveLength(1);
    const n = p.needs_input[0];
    expect(n).toMatchObject({ path: "conditions.C1.op", reason: "contradiction" });
    expect(n.options!.map((o) => o.label)).toEqual(["< 10,000 cr", "< 50,000 cr", "outside 10,000–50,000 cr"]);
    expect(questionFor(n, p)).toBe('"below 10K-50K" — did you mean < 10,000 cr, < 50,000 cr, or outside 10,000–50,000 cr?');
  });

  it("every leaf value in every golden program traces to a span or an answer (verify passes)", async () => {
    for (const t of [SAMPLE, NUMBERED, NIFTY, "All stocks between 10K-50K cr", "All stocks below  10K cr Market Cap"]) {
      const d = await compile(t);
      expect(() => verifyProgram(d.program, d.normalised)).not.toThrow();
    }
  });
});

const MCAP_PARAPHRASES: [string, string][] = [
  ["All stocks between 10K- 50K cr Market Cap", "10000,50000"],
  ["all stocks with market cap between 10,000 and 50,000 crore", "10000,50000"],
  ["All stocks Mcap 10K to 50K cr", "10000,50000"],
  ["All stocks between 10k–50k Cr market cap", "10000,50000"],
  ["All stocks between 10000 - 50000 crores market cap", "10000,50000"],
  ["ALL STOCKS BETWEEN 10K TO 50K CR MARKET CAP", "10000,50000"],
  ["All stocks   between   10K   and   50K   cr   Market   Cap", "10000,50000"],
];
const RSI_PARAPHRASES: [string, string, string][] = [
  ["RSI Range 50 to 65", "50,65", "null"], ["RSI between 50 and 65", "50,65", "null"], ["RSI 50-65", "50,65", "null"],
  ["rsi range 50 to 65", "50,65", "null"], ["RSI(14) between 50 and 65", "50,65", "14"], ["RSI 14 between 50 and 65", "50,65", "14"],
  ["RSI Range 50  to  65", "50,65", "null"],
];
describe("paraphrases", () => {
  it.each(MCAP_PARAPHRASES)("mcap: %s", async (text, v) => {
    const p = (await compile(text)).program;
    expect(p.conditions).toHaveLength(1);
    expect((p.conditions[0].value as number[]).join(",")).toBe(v);
    expect(p.needs_input).toEqual([]);
  });
  it.each(RSI_PARAPHRASES)("rsi: %s", async (text, v, len) => {
    const p = (await compile(`All stocks between 10K-50K cr\nWeekly\n${text}`)).program;
    const rsi = p.conditions.find((c) => "ind" in c.lhs)!;
    expect((rsi.value as number[]).join(",")).toBe(v);
    expect(String((rsi.lhs as any).params.length)).toBe(len);
  });
  it.each([
    ["VStop 10,2", 10, 2], ["VStop(10, 2)", 10, 2], ["vstop 10 2", 10, 2], ["V-Stop 10,2", 10, 2],
  ])("vstop positional params: %s", async (m, len, mult) => {
    const p = (await compile(`Weekly\nflipped on ${m}`)).program;
    expect((p.conditions[0].lhs as any).params).toMatchObject({ length: len, mult, source: null });
  });
  it("reordered steps (RSI line before VStop line) compile the same conditions", async () => {
    const p = (await compile("All stocks between 10K-50K cr\nWeekly\nRSI Range 50 to 65\nflipped on VStop 10,2")).program;
    expect(p.conditions.map((c: any) => c.lhs.ind ?? c.lhs.field)).toEqual(["mcap_cr", "rsi", "vstop"]);
    expect(p.sets.at(-1)!.where).toEqual({ all: ["C2", "C3"] });
  });
  it("noise lines are ignored, not understood-failures", async () => {
    const d = await compile("Read my prompt\nbuild a stock scanner:\nAll stocks between 10K-50K cr");
    expect(d.program.ignored).toHaveLength(2);
    expect(d.program.unrecognised).toEqual([]);
  });
  it("a clause nothing recognises is 'not understood' (never silently dropped)", async () => {
    const d = await compile("All stocks between 10K-50K cr\nthe moon is in the seventh house");
    expect(d.program.unrecognised).toEqual([expect.objectContaining({ clause_id: "L2" })]);
    expect(d.clauses[1].status).toBe("not_understood");
  });
  it("monthly and daily timeframe phrases scope the lines below", async () => {
    const p = (await compile("Monthly candles\nRSI 14 above 60\nDaily timeframe\nEMA 20 above 100")).program;
    expect(p.conditions.map((c: any) => c.lhs.tf)).toEqual(["1M", "1D"]);
  });
  it("a comparator on an indicator: 'RSI(14) above 60'", async () => {
    const p = (await compile("Weekly\nRSI(14) above 60")).program;
    expect(p.conditions[0]).toMatchObject({ op: ">", value: 60 });
  });
  it("missing timeframe is a question, never a guess", async () => {
    const p = (await compile("RSI(14) above 60")).program;
    expect(paths(p)).toContain("conditions.C1.tf");
  });
});
