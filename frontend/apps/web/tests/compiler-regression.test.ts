import { describe, expect, it, vi } from "vitest";
import { compilePrompt, CompileError } from "@/server/compiler/compile";

const CATALOG = [
  { kind: "field", name: "mcap_cr", required_params: [], ops: [{ op: "between", requires_value: true }] },
  { kind: "field", name: "traded_value_cr", required_params: [{ name: "window" }], ops: [{ op: ">=", requires_value: true }] },
  { kind: "indicator", name: "vstop", required_params: [{ name: "length" }, { name: "mult" }, { name: "source" }], ops: [{ op: "flip", requires_value: false }] },
  { kind: "indicator", name: "rsi", required_params: [{ name: "length" }], ops: [{ op: "between", requires_value: true }] },
];
const STRUCTURES = [{ structure: "literal" }, { structure: "t1_literal" }];

function modelReturning(output: unknown) {
  return vi.fn().mockResolvedValue(JSON.stringify(output));
}

describe("compiler regression — no app-supplied values", () => {
  it("the full original brief, fully traceable, compiles in one attempt with the right structure", async () => {
    const callModel = modelReturning({
      structure: "literal",
      conditions: [
        { id: "C1", role: "filter", kind: "field", name: "mcap_cr", params: {}, op: "between", value: [10000, 50000] },
        { id: "C2", role: "filter", kind: "field", name: "traded_value_cr", params: { window: "1W" }, op: ">=", value: 10 },
        { id: "C3", role: "event", kind: "indicator", name: "vstop", params: { length: 10, mult: 2, source: "close" }, op: "flip", dir: "long" },
        { id: "C4", role: "filter", kind: "indicator", name: "rsi", params: { length: 14 }, op: "between", value: [50, 65] },
      ],
      selection_point: { session_of_week: 1, at: "open" }, stop: { from: "C3" }, risk_cap_pct: null, near_miss: null, t1_window: null,
      source_phrases: [
        { path: "conditions.0.value.0", phrase: "10,000cr" }, { path: "conditions.0.value.1", phrase: "50,000cr" },
        { path: "conditions.1.value", phrase: "10cr/week" }, { path: "conditions.1.params.window", phrase: "/week" },
        { path: "conditions.2.params.length", phrase: "VStop 10" }, { path: "conditions.2.params.mult", phrase: "multiplier 2" },
        { path: "conditions.2.params.source", phrase: "on the close" },
        { path: "conditions.3.params.length", phrase: "RSI 14" }, { path: "conditions.3.value.0", phrase: "between 50" }, { path: "conditions.3.value.1", phrase: "and 65" },
        { path: "selection_point.session_of_week", phrase: "Monday" }, { path: "selection_point.at", phrase: "at the open" },
      ],
      needs_input: [], unsupported: [],
    });
    const { output, attempts } = await compilePrompt("...", CATALOG, STRUCTURES, { callModel });
    expect(attempts).toBe(1);
    expect(output.structure).toBe("literal");
    expect(output.conditions).toHaveLength(4);
  });

  it("'VStop flip, no params given' never compiles with a guessed length/mult/source — it is flagged in needs_input instead", async () => {
    const callModel = modelReturning({
      structure: "literal",
      conditions: [{ id: "C1", role: "event", kind: "indicator", name: "vstop", params: {}, op: "flip", dir: "long" }],
      selection_point: null, stop: { from: "C1" }, risk_cap_pct: null, near_miss: null, t1_window: null,
      source_phrases: [],
      needs_input: [
        { path: "conditions.0.params.length", question: "What VStop length?" },
        { path: "conditions.0.params.mult", question: "What VStop multiplier?" },
        { path: "conditions.0.params.source", question: "What price source (open/high/low/close)?" },
      ],
      unsupported: [],
    });
    const { output } = await compilePrompt("VStop flip", CATALOG, STRUCTURES, { callModel });
    expect(output.conditions[0].params).toEqual({});
    expect(output.needs_input).toHaveLength(3);
  });
});

describe("compiler regression — no invented TEXT values either (I3)", () => {
  it("a model that fills in VStop's price source as \"high\" with no phrase for it never gets that value into a compiled spec", async () => {
    const fabricated = {
      structure: "literal",
      conditions: [{ id: "C1", role: "event", kind: "indicator", name: "vstop", params: { length: 10, mult: 2, source: "high" }, op: "flip", dir: "long" }],
      selection_point: null, stop: { from: "C1" }, risk_cap_pct: null, near_miss: null, t1_window: null,
      source_phrases: [{ path: "conditions.0.params.length", phrase: "VStop 10" }, { path: "conditions.0.params.mult", phrase: "2" }],
      needs_input: [], unsupported: [],
    };
    const callModel = modelReturning(fabricated);
    await expect(compilePrompt("VStop(10,2) flip", CATALOG, STRUCTURES, { callModel })).rejects.toBeInstanceOf(CompileError);
  });
});

describe("compiler regression — liquidity exception", () => {
  it("a prompt that never mentions liquidity still never gets a liquidity needs_input item from the compiler", async () => {
    const callModel = modelReturning({
      structure: "literal", conditions: [], selection_point: null, stop: null, risk_cap_pct: null, near_miss: null, t1_window: null,
      source_phrases: [], needs_input: [], unsupported: [],
    });
    const { output } = await compilePrompt("Buy mid-caps in an uptrend", CATALOG, STRUCTURES, { callModel });
    expect(output.needs_input.some((n) => /liquidity/i.test(n.question))).toBe(false);
  });

  it("a model that tries to ask about liquidity anyway is rejected and forced to retry", async () => {
    const callModel = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        structure: "literal", conditions: [], selection_point: null, stop: null, risk_cap_pct: null, near_miss: null, t1_window: null,
        source_phrases: [], needs_input: [{ path: "liquidity", question: "What liquidity floor?" }], unsupported: [],
      }))
      .mockResolvedValueOnce(JSON.stringify({
        structure: "literal", conditions: [], selection_point: null, stop: null, risk_cap_pct: null, near_miss: null, t1_window: null,
        source_phrases: [], needs_input: [], unsupported: [],
      }));
    const { output, attempts } = await compilePrompt("x", CATALOG, STRUCTURES, { callModel });
    expect(attempts).toBe(2);
    expect(output.needs_input).toEqual([]);
  });
});

describe("compiler regression — open parameters (no fixed defaults)", () => {
  it("VStop(14,3), RSI(9), and a 3-session T1 window all compile with exactly the stated numbers, not Control's 10/2/14", async () => {
    const callModel = modelReturning({
      structure: "t1_literal",
      conditions: [
        { id: "C1", role: "event", kind: "indicator", name: "vstop", params: { length: 14, mult: 3, source: "close" }, op: "flip", dir: "long" },
        { id: "C2", role: "filter", kind: "indicator", name: "rsi", params: { length: 9 }, op: "between", value: [50, 65] },
      ],
      selection_point: { session_of_week: 1, at: "open" }, stop: { from: "C1" }, risk_cap_pct: null, near_miss: null,
      t1_window: { length_sessions: 3, offsets: [0, 1, 2] },
      source_phrases: [
        { path: "conditions.0.params.length", phrase: "VStop 14" }, { path: "conditions.0.params.mult", phrase: "3" },
        { path: "conditions.0.params.source", phrase: "close" },
        { path: "conditions.1.params.length", phrase: "RSI 9" }, { path: "conditions.1.value.0", phrase: "50" }, { path: "conditions.1.value.1", phrase: "65" },
        { path: "selection_point.session_of_week", phrase: "Monday" }, { path: "selection_point.at", phrase: "open" },
        { path: "t1_window.length_sessions", phrase: "3-session window" }, { path: "t1_window.offsets.0", phrase: "day 0" }, { path: "t1_window.offsets.1", phrase: "day 1" }, { path: "t1_window.offsets.2", phrase: "day 2" },
      ],
      needs_input: [], unsupported: [],
    });
    const { output } = await compilePrompt("...", CATALOG, STRUCTURES, { callModel });
    expect(output.conditions[0].params).toMatchObject({ length: 14, mult: 3 });
    expect(output.conditions[1].params).toMatchObject({ length: 9 });
    expect(output.t1_window).toEqual({ length_sessions: 3, offsets: [0, 1, 2] });
  });
});

describe("compiler regression — unsupported conditions never silently dropped or swapped", () => {
  it("a MACD condition lands in unsupported with the exact text, never silently matched to a similar catalog entry", async () => {
    const callModel = modelReturning({
      structure: "literal", conditions: [], selection_point: null, stop: null, risk_cap_pct: null, near_miss: null, t1_window: null,
      source_phrases: [], needs_input: [], unsupported: [{ text: "MACD crosses above signal", reason: "MACD is not in the engine's catalog" }],
    });
    const { output } = await compilePrompt("Buy on a MACD crossover", CATALOG, STRUCTURES, { callModel });
    expect(output.unsupported).toEqual([{ text: "MACD crosses above signal", reason: "MACD is not in the engine's catalog" }]);
  });

  it("the same unknown condition, if the model wrongly lists it in conditions instead of unsupported, is caught by catalog validation and forces a retry", async () => {
    const callModel = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        structure: "literal",
        conditions: [{ id: "C1", role: "event", kind: "indicator", name: "macd", params: {}, op: "cross", value: null }],
        selection_point: null, stop: null, risk_cap_pct: null, near_miss: null, t1_window: null,
        source_phrases: [], needs_input: [], unsupported: [],
      }))
      .mockResolvedValueOnce(JSON.stringify({
        structure: "literal", conditions: [], selection_point: null, stop: null, risk_cap_pct: null, near_miss: null, t1_window: null,
        source_phrases: [], needs_input: [], unsupported: [{ text: "MACD crossover", reason: "not in catalog" }],
      }));
    const { output, attempts } = await compilePrompt("Buy on a MACD crossover", CATALOG, STRUCTURES, { callModel });
    expect(attempts).toBe(2);
    expect(output.unsupported).toHaveLength(1);
  });
});
