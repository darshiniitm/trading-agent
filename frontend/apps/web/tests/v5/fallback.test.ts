import { describe, expect, it, vi } from "vitest";
import { compileProgram as resolvingCompile } from "@/server/compiler/v5/compileProgram";
// these tests are about the compiler stage itself, before the interpreter fills open slots (see interpreter.test.ts)
const compileProgram = (t: string, o: any = {}) => resolvingCompile(t, { ...o, resolve: false });
import { buildFallbackPrompt, CLAUSE_JSON_SCHEMA, makeClauseFallback } from "@/server/compiler/v5/fallback";
import { canonicalConditions, GOLDEN } from "@/server/compiler/v5/goldenSet";
import { verifyProgram } from "@/server/compiler/v5/verify";

const NONE = { conditions: [] };
const wrap = (...c: unknown[]) => JSON.stringify({ conditions: c });
const RSI = { kind: "condition", subject: "indicator", indicator: "rsi", timeframe: "1W", op: ">", direction: null,
  args: [{ name: "length", value: 14, phrase: "14" }, { name: "value", value: 60, phrase: "60" }], phrase: "RSI(14) is above 60" };
const NO_COND = new Set(["universe+mcap", "indicators", "patterns"]);

describe("golden set (recognisers on)", () => {
  it.each(GOLDEN.map((g) => [g.id, g] as const))("%s", async (_id, g) => {
    const d = await compileProgram(g.text);
    expect(canonicalConditions(d.program)).toEqual(g.conditions);
    expect(() => verifyProgram(d.program, d.normalised)).not.toThrow();
    expect(d.modelCalls).toBe(0);
  });
  it("has at least 25 paraphrase cases", () => expect(GOLDEN.length).toBeGreaterThanOrEqual(25));
});

describe("model fallback", () => {
  it("is never called for a clause a recogniser claimed", async () => {
    const callModel = vi.fn().mockResolvedValue(wrap(RSI));
    const d = await compileProgram("All stocks between 10K-50K cr\nWeekly\nRSI(14) is above 60", { fallback: makeClauseFallback(callModel) });
    expect(callModel).toHaveBeenCalledTimes(0);
    expect(d.modelCalls).toBe(0);
  });

  it("passes the JSON Schema as Ollama's structured output format, one line per call", async () => {
    const callModel = vi.fn().mockResolvedValue(wrap({ ...RSI, phrase: "relative strength (14) is above 60" }));
    const d = await compileProgram("Weekly\nrelative strength (14) is above 60", { fallback: makeClauseFallback(callModel), disabledRecognisers: new Set(["indicators", "patterns"]) });
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(callModel.mock.calls[0][2]).toEqual(CLAUSE_JSON_SCHEMA);
    expect(callModel.mock.calls[0][1]).toContain("relative strength (14) is above 60");
    expect(d.modelCalls).toBe(1);
  });

  it("a verified model fragment compiles exactly like a recogniser's, and is marked as model-read", async () => {
    const line = "RSI(14) is above 60";
    const d = await compileProgram(`Weekly\n${line}`, { fallback: makeClauseFallback(vi.fn().mockResolvedValue(wrap(RSI))), disabledRecognisers: new Set(["indicators", "patterns"]) });
    expect(canonicalConditions(d.program)).toEqual(["rsi(length=14)@1W > 60"]);
    expect(d.clauses[1].status).toBe("model");
    expect(() => verifyProgram(d.program, d.normalised)).not.toThrow();
  });

  it("rejects a hallucinated number (retry carries the error), then 'not understood' — never a 422, never an invented value", async () => {
    const lie = { ...RSI, args: [{ name: "length", value: 21, phrase: "14" }, { name: "value", value: 60, phrase: "60" }] };
    const callModel = vi.fn().mockResolvedValue(wrap(lie));
    const d = await compileProgram("Weekly\nRSI(14) is above 60", { fallback: makeClauseFallback(callModel), disabledRecognisers: new Set(["indicators", "patterns"]) });
    expect(callModel).toHaveBeenCalledTimes(2);
    expect(callModel.mock.calls[1][1]).toMatch(/cannot be read from/);
    expect(d.program.unrecognised).toHaveLength(1);
    expect(d.program.conditions).toHaveLength(0);
  });

  it("rejects a phrase that is not in the line and non-JSON output", async () => {
    const bad = { ...RSI, phrase: "something else entirely" };
    const d1 = await compileProgram("Weekly\nRSI(14) is above 60", { fallback: makeClauseFallback(vi.fn().mockResolvedValue(wrap(bad))), disabledRecognisers: new Set(["indicators", "patterns"]) });
    expect(d1.program.unrecognised).toHaveLength(1);
    const d2 = await compileProgram("Weekly\nRSI(14) is above 60", { fallback: makeClauseFallback(vi.fn().mockResolvedValue("not json")), disabledRecognisers: new Set(["indicators", "patterns"]) });
    expect(d2.program.unrecognised).toHaveLength(1);
  });

  it("'none' from the model leaves the clause not understood (rephrase / ignore)", async () => {
    const d = await compileProgram("the moon is in the seventh house", { fallback: makeClauseFallback(vi.fn().mockResolvedValue(JSON.stringify(NONE))) });
    expect(d.clauses[0].status).toBe("not_understood");
  });

  it("a timeframe the line does not state is dropped, not trusted (the scope line supplies it)", async () => {
    const invented = { ...RSI, timeframe: "1D" };
    const d = await compileProgram("Weekly\nRSI(14) is above 60", { fallback: makeClauseFallback(vi.fn().mockResolvedValue(wrap(invented))), disabledRecognisers: new Set(["indicators", "patterns"]) });
    expect(canonicalConditions(d.program)).toEqual(["rsi(length=14)@1W > 60"]);
  });

  it("one line stating two conditions yields two conditions from one call", async () => {
    const A = { kind: "condition", subject: "indicator", indicator: "vstop", timeframe: null, op: "flip", direction: "long", args: [{ name: "length", value: 10, phrase: "10" }, { name: "mult", value: 2, phrase: "2" }], phrase: "VStop 10,2 flipped" };
    const B = { kind: "condition", subject: "indicator", indicator: "rsi", timeframe: null, op: "between", direction: null, args: [{ name: "value.0", value: 50, phrase: "50" }, { name: "value.1", value: 65, phrase: "65" }], phrase: "RSI 50 to 65" };
    const callModel = vi.fn().mockResolvedValue(wrap(A, B));
    const d = await compileProgram("Weekly\nVStop 10,2 flipped and RSI 50 to 65", { fallback: makeClauseFallback(callModel), disabledRecognisers: new Set(["indicators", "patterns"]) });
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(canonicalConditions(d.program)).toEqual(["vstop(length=10,mult=2,source=?)@1W flip long", "rsi(length=?)@1W between 50,65"]);
  });

  it("the prompt tells the model never to invent values and includes few-shot examples", () => {
    const { system, user } = buildFallbackPrompt("RSI above 60");
    expect(system).toMatch(/Never invent/);
    expect(system).toMatch(/Line: "the moon is in the seventh house"/);
    expect(user).toBe('Line: "RSI above 60"');
  });

  it("with the condition recognisers disabled, a mock model reproduces a golden case (the evaluation path)", async () => {
    const g = GOLDEN.find((x) => x.id === "mcap-1")!;
    const model = { kind: "condition", subject: "market_cap", indicator: null, timeframe: null, op: "between", direction: null,
      args: [{ name: "value.0", value: 10000, phrase: "10K" }, { name: "value.1", value: 50000, phrase: "50K" }], phrase: "between 10K- 50K cr Market Cap" };
    const d = await compileProgram(g.text, { disabledRecognisers: NO_COND, fallback: makeClauseFallback(vi.fn().mockResolvedValue(wrap(model))) });
    expect(canonicalConditions(d.program)).toEqual(g.conditions);
  });
});
