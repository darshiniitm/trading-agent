import { describe, expect, it, vi } from "vitest";
import { compilePrompt, CompileError } from "@/server/compiler/compile";

const CATALOG = [
  { kind: "field", name: "mcap_cr", required_params: [], ops: [{ op: "between", requires_value: true }] },
  { kind: "indicator", name: "vstop", required_params: [{ name: "length" }, { name: "mult" }, { name: "source" }], ops: [{ op: "flip", requires_value: false }] },
];
const STRUCTURES = [{ structure: "literal" }, { structure: "t1_literal" }];

function fullyTraceableOutput() {
  return {
    structure: "literal",
    conditions: [{ id: "C1", role: "event", kind: "indicator", name: "vstop", params: { length: 10, mult: 2, source: "close" }, op: "flip", dir: "long" }],
    selection_point: null, stop: { from: "C1" }, risk_cap_pct: null, near_miss: null, t1_window: null,
    source_phrases: [{ path: "conditions.0.params.length", phrase: "VStop 10" }, { path: "conditions.0.params.mult", phrase: "mult 2" }],
    needs_input: [], unsupported: [],
  };
}

describe("compilePrompt", () => {
  it("succeeds on the first attempt when the model's output is fully valid and traceable", async () => {
    const callModel = vi.fn().mockResolvedValue(JSON.stringify(fullyTraceableOutput()));
    const { output, attempts } = await compilePrompt("VStop(10,2,close) flip up", CATALOG, STRUCTURES, { callModel });
    expect(attempts).toBe(1);
    expect(output.structure).toBe("literal");
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it("retries once with the errors when the first response has an untraceable number, then succeeds", async () => {
    const badOutput = { ...fullyTraceableOutput(), source_phrases: [] }; // length/mult now untraceable
    const callModel = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(badOutput))
      .mockResolvedValueOnce(JSON.stringify(fullyTraceableOutput()));
    const { attempts } = await compilePrompt("VStop(10,2,close) flip up", CATALOG, STRUCTURES, { callModel });
    expect(attempts).toBe(2);
    expect(callModel).toHaveBeenCalledTimes(2);
    const secondCallUser = callModel.mock.calls[1][1];
    expect(secondCallUser).toMatch(/no source phrase/);
  });

  it("throws CompileError after a second consecutive failure, never a third attempt", async () => {
    const callModel = vi.fn().mockResolvedValue("not json at all");
    await expect(compilePrompt("x", CATALOG, STRUCTURES, { callModel })).rejects.toBeInstanceOf(CompileError);
    expect(callModel).toHaveBeenCalledTimes(2);
  });

  it("rejects a condition naming something outside the catalog as a validation error, not a crash", async () => {
    const withUnknown = {
      ...fullyTraceableOutput(),
      conditions: [...fullyTraceableOutput().conditions, { id: "C2", role: "filter", kind: "indicator", name: "macd", params: {}, op: ">", value: 0 }],
    };
    const callModel = vi.fn().mockResolvedValue(JSON.stringify(withUnknown));
    await expect(compilePrompt("x", CATALOG, STRUCTURES, { callModel })).rejects.toBeInstanceOf(CompileError);
  });

  it("rejects a needs_input item that asks about liquidity", async () => {
    const withLiquidityQuestion = { ...fullyTraceableOutput(), needs_input: [{ path: "conditions.0.params.length", question: "What liquidity floor?" }] };
    const callModel = vi.fn().mockResolvedValue(JSON.stringify(withLiquidityQuestion));
    await expect(compilePrompt("x", CATALOG, STRUCTURES, { callModel })).rejects.toBeInstanceOf(CompileError);
  });

  it("retries once when the first response is syntactically-valid JSON but fails zod validation, then succeeds", async () => {
    // "needs_input" items require a non-empty "question" — omitting it is valid JSON but invalid per CompileOutputSchema.
    const zodInvalidOutput = { ...fullyTraceableOutput(), needs_input: [{ path: "conditions.0.params.length" }] };
    const callModel = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(zodInvalidOutput))
      .mockResolvedValueOnce(JSON.stringify(fullyTraceableOutput()));
    const { attempts } = await compilePrompt("VStop(10,2,close) flip up", CATALOG, STRUCTURES, { callModel });
    expect(attempts).toBe(2);
    expect(callModel).toHaveBeenCalledTimes(2);
    const secondCallUser = callModel.mock.calls[1][1];
    expect(secondCallUser).toMatch(/needs_input\.0\.question/);
  });

  it("rejects a condition missing a required catalog param that is NOT flagged in needs_input, forcing a retry", async () => {
    const base = fullyTraceableOutput();
    const missingMultUnflagged = {
      ...base,
      conditions: [{ ...base.conditions[0], params: { length: 10, source: "close" } }], // mult dropped, no needs_input entry
      source_phrases: base.source_phrases.filter((s) => s.path !== "conditions.0.params.mult"),
    };
    const callModel = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(missingMultUnflagged))
      .mockResolvedValueOnce(JSON.stringify(fullyTraceableOutput()));
    const { attempts } = await compilePrompt("VStop(10,2,close) flip up", CATALOG, STRUCTURES, { callModel });
    expect(attempts).toBe(2);
    expect(callModel).toHaveBeenCalledTimes(2);
    const secondCallUser = callModel.mock.calls[1][1];
    expect(secondCallUser).toMatch(/conditions\.0\.params\.mult/);
  });

  it("accepts a condition missing a required catalog param when it IS flagged in needs_input (success, no retry)", async () => {
    const base = fullyTraceableOutput();
    const missingMultFlagged = {
      ...base,
      conditions: [{ ...base.conditions[0], params: { length: 10, source: "close" } }], // mult dropped
      needs_input: [{ path: "conditions.0.params.mult", question: "What multiplier should VStop use?" }],
      source_phrases: base.source_phrases.filter((s) => s.path !== "conditions.0.params.mult"),
    };
    const callModel = vi.fn().mockResolvedValue(JSON.stringify(missingMultFlagged));
    const { attempts, output } = await compilePrompt("VStop(10,?,close) flip up", CATALOG, STRUCTURES, { callModel });
    expect(attempts).toBe(1);
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(output.needs_input).toHaveLength(1);
  });
});
