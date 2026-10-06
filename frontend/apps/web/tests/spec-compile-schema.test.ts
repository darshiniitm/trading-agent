import { describe, expect, it } from "vitest";
import { CompileOutputSchema } from "spec";

describe("CompileOutputSchema", () => {
  it("accepts a fully-known literal output", () => {
    const out = CompileOutputSchema.parse({
      structure: "literal",
      conditions: [{ id: "C1", role: "event", kind: "indicator", name: "vstop", params: { length: 10, mult: 2, source: "close" }, op: "flip", dir: "long" }],
      selection_point: { session_of_week: 1, at: "open" },
      stop: { from: "C1" }, risk_cap_pct: null, near_miss: null, t1_window: null,
      source_phrases: [
        { path: "structure", phrase: "weekly close" },
        { path: "conditions.0.params.length", phrase: "VStop 10" },
        { path: "conditions.0.params.mult", phrase: "multiplier 2" },
        { path: "selection_point.session_of_week", phrase: "Monday" },
      ],
      needs_input: [], unsupported: [],
    });
    expect(out.conditions).toHaveLength(1);
  });

  it("accepts a partial output with a condition missing params, flagged in needs_input", () => {
    const out = CompileOutputSchema.parse({
      structure: "literal",
      conditions: [{ id: "C1", role: "event", kind: "indicator", name: "vstop", params: {}, op: "flip", dir: "long" }],
      selection_point: null, stop: null, risk_cap_pct: null, near_miss: null, t1_window: null,
      source_phrases: [],
      needs_input: [{ path: "conditions.0.params.length", question: "What VStop length?" }],
      unsupported: [],
    });
    expect(out.needs_input).toHaveLength(1);
  });

  it("accepts structure: null for an unclear prompt", () => {
    const out = CompileOutputSchema.parse({
      structure: null, conditions: [], selection_point: null, stop: null, risk_cap_pct: null, near_miss: null, t1_window: null,
      source_phrases: [], needs_input: [], unsupported: [{ text: "something vague", reason: "not a recognisable condition" }],
    });
    expect(out.structure).toBeNull();
  });

  it("rejects a needs_input item with no path or question", () => {
    expect(() =>
      CompileOutputSchema.parse({
        structure: "literal", conditions: [], selection_point: null, stop: null, risk_cap_pct: null, near_miss: null, t1_window: null,
        source_phrases: [], needs_input: [{ path: "" }], unsupported: [],
      })
    ).toThrow();
  });
});
