// P0 of docs/prompt-agent-interpreter-plan.md: the procedural Nifty 100 SMA prompt (R1–R4).
import { describe, expect, it } from "vitest";
import { compileProgram } from "@/server/compiler/v5/compileProgram";

export const NIFTY_PROCEDURAL = `Build a Nifty 100 SMA crossover scanner:
Load them
Fetch daily historical candles
Calculate SMA 6 and SMA 30
Detect bullish and bearish crossovers
Rank stocks by the most recent crossover date first`;

const stage = (t: string, o: any = {}) => compileProgram(t, { ...o, resolve: false });

describe("P0 — procedural prompt: Nifty 100 SMA crossover", () => {
  it("R1 the title line keeps its universe; R2 compute+detect lines merge into one cross condition; R4 rank key resolves", async () => {
    let calls = 0;
    const d = await stage(NIFTY_PROCEDURAL, { fallback: async () => { calls++; return []; } });
    const p = d.program;
    expect(calls).toBe(0);
    expect(p.universe).toMatchObject({ source: "index", index: "NIFTY 100" });
    expect(p.conditions).toHaveLength(1);
    expect(p.conditions[0]).toMatchObject({
      lhs: { ind: "sma", params: { length: 6, source: null }, tf: "1D" }, op: "cross_any",
      rhs: { ind: "sma", params: { length: 30, source: null }, tf: "1D" },
    });
    expect(p.conditions[0].emit).toEqual(["direction", "event_date"]);
    expect(p.actions).toHaveLength(1);
    expect(p.actions[0]).toMatchObject({ type: "rank", by: [{ key: "C1.event_date", order: "desc" }] });
    expect(p.unrecognised).toEqual([]);
    expect(p.needs_input.map((n) => n.path)).toEqual(["conditions.C1.params.source", "conditions.C1.rhs.params.source"]);
  });

  it("every line is accounted for: none is 'not understood'", async () => {
    const d = await stage(NIFTY_PROCEDURAL);
    expect(d.clauses.map((c) => c.status)).not.toContain("not_understood");
    expect(d.clauses).toHaveLength(6);
    expect(d.clauses[0].maps_to).toMatch(/NIFTY 100/);
    expect(d.clauses[3].maps_to).toMatch(/crossover/);
    expect(d.clauses[4].maps_to).toMatch(/C1/);
  });

  it("bullish only / bearish only pick the direction", async () => {
    const up = await stage(NIFTY_PROCEDURAL.replace("bullish and bearish crossovers", "bullish crossovers"));
    expect(up.program.conditions[0].op).toBe("cross_above");
    const dn = await stage(NIFTY_PROCEDURAL.replace("bullish and bearish crossovers", "bearish crossovers within the last 3 days"));
    expect(dn.program.conditions[0]).toMatchObject({ op: "cross_below", within_bars: 3 });
  });

  it("a title with an indicator mention does not become a half condition; a lone compute line is ignored with a reason", async () => {
    const d = await stage("Build a Nifty 100 SMA crossover scanner:\nCalculate SMA 6 and SMA 30");
    expect(d.program.conditions).toEqual([]);
    expect(d.program.unrecognised).toEqual([]);
    expect(d.clauses[1].status).toBe("ignored");
  });

  it("a crossover line with no series before it is not understood (never invented)", async () => {
    const d = await stage("Nifty 100 stocks\nDetect bullish crossovers");
    expect(d.program.conditions).toEqual([]);
    expect(d.clauses[1].status).toBe("not_understood");
  });

  it("same prompt -> same program, 10 runs", async () => {
    const hs = new Set<string>();
    for (let i = 0; i < 10; i++) hs.add(JSON.stringify((await stage(NIFTY_PROCEDURAL)).program));
    expect(hs.size).toBe(1);
  });
});

describe("P0 R3 — the model fallback may express a crossover of two indicators", () => {
  it("accepts a verified cross_above line and rejects an invented second indicator value", async () => {
    const { makeClauseFallback } = await import("@/server/compiler/v5/fallback");
    const good = JSON.stringify({ conditions: [{ kind: "condition", subject: "indicator", indicator: "sma", rhs_indicator: "ema", timeframe: "1D", op: "cross_above", direction: null,
      args: [{ name: "length", value: 6, phrase: "6" }, { name: "rhs.length", value: 30, phrase: "30" }], phrase: "SMA 6 over EMA 30" }] });
    const fb = makeClauseFallback(async () => good);
    const frags = await fb("daily SMA 6 over EMA 30", 0);
    expect(frags[0]).toMatchObject({ kind: "condition", op: "cross_above", lhs: { ind: "sma", params: { length: 6 } }, rhs: { ind: "ema", params: { length: 30 } } });
    const bad = JSON.stringify({ conditions: [{ kind: "condition", subject: "indicator", indicator: "sma", rhs_indicator: "ema", timeframe: "1D", op: "cross_above", direction: null,
      args: [{ name: "length", value: 6, phrase: "6" }, { name: "rhs.length", value: 50, phrase: "30" }], phrase: "SMA 6 over EMA 30" }] });
    expect(await makeClauseFallback(async () => bad)("daily SMA 6 over EMA 30", 0)).toEqual([]);
  });
});

describe("P1 — recognised but not computable", () => {
  it("names the uncomputable indicator instead of 'not understood', and keeps the computable condition", async () => {
    const d = await stage("Nifty 100 stocks\nWeekly\nRSI(14) above 60\nIchimoku cloud breakout");
    expect(d.program.conditions).toHaveLength(1);
    expect(d.program.unsupported).toEqual([{ text: "Ichimoku cloud breakout", reason: "recognised: Ichimoku Cloud, not computable yet" }]);
    expect(d.program.unrecognised).toEqual([]);
    expect(d.clauses[3].maps_to).toMatch(/Ichimoku Cloud, not computable yet/);
  });

  it("a mixed line keeps the computable part and reports the rest", async () => {
    const d = await stage("Weekly\nRSI(14) above 60 and ADX above 25");
    expect(d.program.conditions.map((c) => (c.lhs as any).ind)).toEqual(["rsi"]);
    expect(d.program.unsupported[0].reason).toBe("recognised: ADX, not computable yet");
  });

  it("the interpreter greys it out with that reason and the screen still runs", async () => {
    const d = await compileProgram("Nifty 100 stocks\nWeekly\nRSI(14) above 60\nIchimoku cloud breakout");
    expect(d.program.not_evaluable?.some((n) => /Ichimoku Cloud, not computable yet/.test(n.reason))).toBe(true);
    expect(d.program.needs_input).toEqual([]);
  });
});
