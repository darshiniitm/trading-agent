import { describe, expect, it } from "vitest";
import { assertTraceable, numericLeafPaths, UntraceableValueError } from "@/server/compiler/traceability";

const BASE = {
  conditions: [
    { id: "C1", role: "event", kind: "indicator", name: "vstop", params: { length: 10, mult: 2, source: "close" }, op: "flip", dir: "long" },
    { id: "C2", role: "filter", kind: "field", name: "mcap_cr", params: {}, op: "between", value: [10000, 50000] },
  ],
  risk_cap_pct: 15, near_miss: { max_failed: 1 },
  selection_point: { session_of_week: 1, at: "open" }, t1_window: { length_sessions: 5, offsets: [0, 1] },
};

describe("numericLeafPaths", () => {
  it("finds every numeric leaf by its canonical path", () => {
    const paths = numericLeafPaths(BASE as any);
    expect(paths).toEqual(
      expect.arrayContaining([
        "conditions.0.params.length", "conditions.0.params.mult",
        "conditions.1.value.0", "conditions.1.value.1",
        "risk_cap_pct", "near_miss.max_failed", "selection_point.session_of_week",
        "t1_window.length_sessions", "t1_window.offsets.0", "t1_window.offsets.1",
      ])
    );
    // "source" (an enum string, not a number) must never appear as a leaf.
    expect(paths).not.toContain("conditions.0.params.source");
  });
});

describe("assertTraceable", () => {
  it("passes when every numeric leaf has a source phrase", () => {
    const phrases = [
      { path: "conditions.0.params.length", phrase: "x" }, { path: "conditions.0.params.mult", phrase: "x" },
      { path: "conditions.1.value.0", phrase: "x" }, { path: "conditions.1.value.1", phrase: "x" },
      { path: "risk_cap_pct", phrase: "x" }, { path: "near_miss.max_failed", phrase: "x" },
      { path: "selection_point.session_of_week", phrase: "x" },
      { path: "t1_window.length_sessions", phrase: "x" }, { path: "t1_window.offsets.0", phrase: "x" }, { path: "t1_window.offsets.1", phrase: "x" },
    ];
    expect(() => assertTraceable(BASE as any, phrases)).not.toThrow();
  });

  it("throws UntraceableValueError listing exactly the missing paths", () => {
    try {
      assertTraceable(BASE as any, []);
      throw new Error("expected assertTraceable to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UntraceableValueError);
      expect((err as any).paths).toContain("risk_cap_pct");
      expect((err as any).paths).toContain("conditions.0.params.length");
    }
  });

  it("accepts a path covered by answeredPaths instead of a source phrase", () => {
    const partial = { conditions: [{ id: "C1", role: "event", kind: "indicator", name: "vstop", params: {}, op: "flip", dir: "long" }], risk_cap_pct: null, near_miss: null, selection_point: null, t1_window: null };
    expect(() => assertTraceable(partial as any, [], ["conditions.0.params.length"])).not.toThrow();
  });
});
