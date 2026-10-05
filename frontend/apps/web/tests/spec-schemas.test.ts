import { describe, expect, it } from "vitest";
import { ConditionSchema, ScreenSpecSchema } from "spec";

describe("ConditionSchema", () => {
  it("rejects a condition missing role/kind/name/op", () => {
    expect(() => ConditionSchema.parse({ id: "C1" })).toThrow();
  });

  it("accepts a vstop flip event condition", () => {
    const c = ConditionSchema.parse({
      id: "C3", role: "event", kind: "indicator", name: "vstop",
      params: { length: 10, mult: 2, source: "close" }, op: "flip", dir: "long",
    });
    expect(c.id).toBe("C3");
  });
});

describe("ScreenSpecSchema", () => {
  it("rejects a structure other than literal/t1_literal", () => {
    expect(() =>
      ScreenSpecSchema.parse({
        spec_version: 4, structure: "control", timeframe: "1W",
        selection_point: null, conditions: [], stop: null, risk_cap_pct: null, near_miss: null,
      })
    ).toThrow();
  });

  it("accepts the full original-brief spec from backend plan §2.1", () => {
    const spec = ScreenSpecSchema.parse({
      spec_version: 4, structure: "literal", timeframe: "1W",
      selection_point: { session_of_week: 1, at: "open" },
      conditions: [
        { id: "C1", role: "filter", kind: "field", name: "mcap_cr", op: "between", value: [10000, 50000] },
        { id: "C2", role: "filter", kind: "field", name: "traded_value_cr", params: { window: "1W" }, op: ">=", value: 10 },
        { id: "C3", role: "event", kind: "indicator", name: "vstop", params: { length: 10, mult: 2, source: "close" }, op: "flip", dir: "long" },
        { id: "C4", role: "filter", kind: "indicator", name: "rsi", params: { length: 14 }, op: "between", value: [50, 65] },
      ],
      stop: { from: "C3" }, risk_cap_pct: null, near_miss: { max_failed: 1 },
    });
    expect(spec.conditions).toHaveLength(4);
    expect(spec.stop?.from).toBe("C3");
  });

  it("rejects duplicate condition ids", () => {
    expect(() =>
      ScreenSpecSchema.parse({
        spec_version: 4, structure: "literal", timeframe: "1W", selection_point: null,
        conditions: [
          { id: "C1", role: "filter", kind: "field", name: "mcap_cr", op: "between", value: [1, 2] },
          { id: "C1", role: "filter", kind: "field", name: "mcap_cr", op: "between", value: [1, 2] },
        ],
        stop: null, risk_cap_pct: null, near_miss: null,
      })
    ).toThrow();
  });
});
