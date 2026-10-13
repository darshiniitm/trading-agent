// The local-model safety net: what the model says is validated against the registry and the words of the line, rule by
// rule; invented numbers are rejected, good rules are kept, and an unreachable model never breaks the compile.
import { describe, expect, it, vi } from "vitest";
import { makeModelReader, buildModelPrompt, pickExamples, readExamples, toFragment, MODEL_JSON_SCHEMA } from "@/server/compiler/v5/modelRead";
import { compileProgram } from "@/server/compiler/v5/compileProgram";
import { verifyProgram } from "@/server/compiler/v5/verify";
import type { Clause } from "@/server/compiler/v5/segment";

const clause = (text: string): Clause => ({ id: "L1", text, start: 0, end: text.length, number: null });
const price = (source: string) => ({ kind: "price", indicator: null, source, params: [], output: null, timeframe: null });
const ind = (indicator: string, params: Record<string, number>, output: string | null = null) =>
  ({ kind: "indicator", indicator, source: null, params: Object.entries(params).map(([name, value]) => ({ name, value })), output, timeframe: null });
const rule = (o: Record<string, unknown>) => ({ left: price("close"), op: ">", right: null, value: null, range: null, multiplier: null, within_bars: null, bars: null, direction: null, phrase: "x", ...o });
const said = (...rules: unknown[]) => JSON.stringify({ conditions: rules });

const LINE = "volume is double the 20 day average volume";

describe("model reader — validation", () => {
  it("turns a valid answer into a rule with traced numbers and visible assumptions", async () => {
    const call = vi.fn().mockResolvedValue(said(rule({ left: price("volume"), op: ">=", right: ind("volume_avg", { length: 20, skip: 1 }), multiplier: 2, phrase: LINE })));
    const got = await makeModelReader(call)({ clause: clause(LINE), leftover: LINE, understood: [] });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ op: ">=", rhs_mult: 2, rhs: { ind: "volume_avg", params: { length: 20, skip: 1 } } });
    expect((got[0].lhs as any).tf).toBe("1D");                                         // "20 day" states a daily bar
    expect(got[0].leaves.map((l) => l.path)).toContain("rhs.params.length");            // 20 is in the words
    expect((got[0].implied ?? []).some((i) => i.path === "rhs_mult" && /local model/.test(i.label))).toBe(true);   // "double" is a conversion, shown as an assumption
  });

  it("rejects a number that is neither in the words nor a stated conversion, tells the model why, and asks once more", async () => {
    const lie = said(rule({ left: price("close"), right: ind("sma", { length: 77 }), phrase: "price above the 150 day SMA" }));
    const call = vi.fn().mockResolvedValue(lie);
    const got = await makeModelReader(call)({ clause: clause("price above the 150 day SMA"), leftover: "price above the 150 day SMA", understood: [] });
    expect(got).toEqual([]);
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1][1]).toMatch(/rejected/);
    expect(call.mock.calls[1][1]).toMatch(/77/);
  });

  it("keeps the rules that are fine and drops only the rejected one", async () => {
    const good = rule({ left: price("close"), right: ind("sma", { length: 150 }), phrase: "price above the 150 day SMA" });
    const bad = rule({ left: ind("adx", { length: 14 }), value: 99, phrase: "price above the 150 day SMA" });
    const call = vi.fn().mockResolvedValue(said(good, bad));
    const got = await makeModelReader(call)({ clause: clause("price above the 150 day SMA"), leftover: "price above the 150 day SMA", understood: [] });
    expect(got).toHaveLength(1);
    expect(got[0].rhs).toMatchObject({ ind: "sma", params: { length: 150 } });
  });

  it("rejects an unknown parameter, an output the indicator lacks, a self-comparison, and a quote that is not in the line", async () => {
    const t = "close above the 150 day SMA";
    const cases = [
      rule({ left: ind("sma", { period: 150 }), value: 1, phrase: t }),
      rule({ left: ind("macd", { fast: 12, slow: 26, signal: 9 }, "bogus"), value: 0, phrase: t }),
      rule({ left: price("close"), right: price("close"), phrase: t }),
      rule({ left: price("close"), right: ind("sma", { length: 150 }), phrase: "something the prompt never said" }),
    ];
    for (const c of cases) {
      const call = vi.fn().mockResolvedValue(said(c));
      expect(await makeModelReader(call, { attempts: 1 })({ clause: clause(t), leftover: t, understood: [] })).toEqual([]);
    }
  });

  it("a quote cut from the leftover (stray punctuation, a leading 'and') still finds its place in the line", () => {
    const f = toFragment(rule({ left: price("volume"), op: ">=", right: ind("volume_avg", { length: 20, skip: 1 }), multiplier: 2, phrase: ": and volume is double the 20 day average volume" }) as any,
      clause("Nifty 500: close is a new high and volume is double the 20 day average volume"), "");
    expect(f.phrase).toMatch(/volume is double the 20 day average volume$/);
    expect(f.phrase).not.toMatch(/^:/);
    expect(f.span[0]).toBeGreaterThan(0);
  });

  it("a crossover without a window is read as 'in the last bar' and says so", () => {
    const f = toFragment(rule({ left: ind("ema", { length: 9 }), op: "cross_above", right: ind("ema", { length: 21 }), phrase: "9 EMA crosses above 21 EMA" }) as any, clause("9 EMA crosses above 21 EMA"), "");
    expect(f.within_bars).toBe(1);
    expect((f.implied ?? []).some((i) => i.path === "within_bars")).toBe(true);
  });
});

describe("model reader — in the compiler", () => {
  it("is asked only about the words the rules left unread, one short piece at a time", async () => {
    const seen: string[] = [];
    const d = await compileProgram("Nifty 100 stocks where the 50 DMA crossed above the 200 DMA in the last 10 sessions, and price pops over 5", { modelRead: async (i) => { seen.push(i.leftover); return []; } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/pops over 5/);
    expect(seen[0]).not.toMatch(/DMA/);
    expect(d.program.conditions.length).toBeGreaterThanOrEqual(2);       // the rules' reading stands
  });

  it("is never asked about a prompt the rules read completely", async () => {
    const modelRead = vi.fn().mockResolvedValue([]);
    await compileProgram("Nifty 500 stocks closing at a new 52-week high today with volume at least 2 times the 20-day average", { modelRead });
    expect(modelRead).not.toHaveBeenCalled();
  });

  it("what the model reads becomes a rule that verifies, marked as model-read", async () => {
    const modelRead = makeModelReader(vi.fn().mockResolvedValue(said(rule({ left: price("volume"), op: ">=", right: ind("volume_avg", { length: 20, skip: 1 }), multiplier: 3, phrase: "volume surges to thrice its 20 day average" }))));
    const d = await compileProgram("Nifty 100 stocks where volume surges to thrice its 20 day average", { modelRead });
    expect(d.program.conditions.some((c: any) => c.rhs?.ind === "volume_avg" && c.rhs_mult === 3)).toBe(true);
    expect(() => verifyProgram(d.program, d.normalised)).not.toThrow();
    expect(d.clauses[0].status).toBe("model");
  });

  it("a restated rule is not added twice", async () => {
    const modelRead = vi.fn().mockResolvedValue([]);
    const d = await compileProgram("Nifty 500 stocks closing at a new 52-week high today with volume at least 2 times the 20-day average and hitting a gap", { modelRead });
    const keys = d.program.conditions.map((c: any) => JSON.stringify([c.lhs, c.op, c.rhs, c.value, c.rhs_mult]));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("words nobody could read are flagged so the screen shows partial matches, not silently ignored", async () => {
    const d = await compileProgram("Nifty 100 stocks where the mood is bullish above 5", { modelRead: async () => [] });
    expect(d.program.not_evaluable?.some((n) => /could not be turned into a rule/.test(n.reason))).toBe(true);
  });

  it("an unreachable model never breaks the compile: the rules' reading stands and the error is reported", async () => {
    const d = await compileProgram("Nifty 100 stocks where the 50 DMA crossed above the 200 DMA in the last 10 sessions, and price pops over 5", { modelRead: async () => { throw new Error("Ollama is not reachable"); } });
    expect(d.modelError).toMatch(/not reachable/);
    expect(d.program.conditions.length).toBeGreaterThanOrEqual(2);
  });
});

describe("model reader — the prompt", () => {
  it("shows the model the compiler's own correct readings, picked by what the leftover is about", async () => {
    const all = await readExamples();
    expect(all.length).toBeGreaterThanOrEqual(8);
    const picked = pickExamples(all, "volume is double the 20 day average volume", 3).map((e) => e.text);
    expect(picked[0]).toMatch(/volume/);
    const { system, user } = buildModelPrompt("line", ["already"], "leftover words", picked.map((t) => all.find((e) => e.text === t)!));
    expect(system).toMatch(/high_n/);
    expect(system).toMatch(/Never invent|never invent/i);
    expect(user).toMatch(/ALREADY READ/);
  });

  it("asks for a constrained JSON answer (indicator / op names are enums)", () => {
    const s = JSON.stringify(MODEL_JSON_SCHEMA);
    expect(s).toContain("cross_above");
    expect(s).toContain("momentum_skip");
    expect(s).not.toContain('"bar"');
  });
});
