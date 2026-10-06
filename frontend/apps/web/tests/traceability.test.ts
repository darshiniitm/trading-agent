import { describe, expect, it } from "vitest";
import { assertTraceable, traceableLeafPaths, UntraceableValueError } from "@/server/compiler/traceability";

const BASE = {
  conditions: [
    { id: "C1", role: "event", kind: "indicator", name: "vstop", params: { length: 10, mult: 2, source: "close" }, op: "flip", dir: "long" },
    { id: "C2", role: "filter", kind: "field", name: "mcap_cr", params: {}, op: "between", value: [10000, 50000] },
  ],
  stop: { from: "C1" },
  risk_cap_pct: 15, near_miss: { max_failed: 1 },
  selection_point: { session_of_week: 1, at: "open" }, t1_window: { length_sessions: 5, offsets: [0, 1] },
};

const ALL_PHRASES = [
  "conditions.0.params.length", "conditions.0.params.mult", "conditions.0.params.source",
  "conditions.1.value.0", "conditions.1.value.1",
  "risk_cap_pct", "near_miss.max_failed", "selection_point.session_of_week", "selection_point.at",
  "t1_window.length_sessions", "t1_window.offsets.0", "t1_window.offsets.1",
].map((path) => ({ path, phrase: "x" }));

describe("traceableLeafPaths", () => {
  it("finds every parameter value — numeric AND text — by its canonical path", () => {
    expect(traceableLeafPaths(BASE as any).sort()).toEqual(ALL_PHRASES.map((p) => p.path).sort());
  });

  it("includes text param values and selection_point.at (I3: a fabricated string is an invented value too)", () => {
    const paths = traceableLeafPaths(BASE as any);
    expect(paths).toContain("conditions.0.params.source");
    expect(paths).toContain("selection_point.at");
  });

  it("never includes structural, compiler-decided fields: id, role, kind, name, op, dir, stop.from", () => {
    const paths = traceableLeafPaths(BASE as any);
    for (const p of paths) {
      expect(p).not.toMatch(/\.(id|role|kind|name|op|dir)$/);
      expect(p).not.toMatch(/^stop/);
    }
  });

  it("covers a text condition value and a text window param", () => {
    const out = { conditions: [{ params: { window: "1W" }, value: "up" }], risk_cap_pct: null, near_miss: null, selection_point: null, t1_window: null };
    expect(traceableLeafPaths(out)).toEqual(["conditions.0.value", "conditions.0.params.window"]);
  });

  it("skips null/absent values (a missing param is a needs_input item, not a leaf)", () => {
    const out = { conditions: [{ params: { length: null as unknown }, value: null }], risk_cap_pct: null, near_miss: null, selection_point: null, t1_window: null };
    expect(traceableLeafPaths(out)).toEqual([]);
  });
});

describe("assertTraceable", () => {
  it("passes when every leaf has a source phrase", () => {
    expect(() => assertTraceable(BASE as any, ALL_PHRASES)).not.toThrow();
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

  it("rejects a fabricated text param value with no source phrase (e.g. source: \"high\")", () => {
    const phrases = ALL_PHRASES.filter((p) => p.path !== "conditions.0.params.source");
    try {
      assertTraceable(BASE as any, phrases);
      throw new Error("expected assertTraceable to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UntraceableValueError);
      expect((err as any).paths).toEqual(["conditions.0.params.source"]);
    }
  });

  it("rejects a fabricated selection_point.at with no source phrase", () => {
    const phrases = ALL_PHRASES.filter((p) => p.path !== "selection_point.at");
    expect(() => assertTraceable(BASE as any, phrases)).toThrow(/selection_point\.at/);
  });

  it("accepts a path covered by answeredPaths instead of a source phrase", () => {
    const partial = { conditions: [{ id: "C1", role: "event", kind: "indicator", name: "vstop", params: { source: "close" }, op: "flip", dir: "long" }], risk_cap_pct: null, near_miss: null, selection_point: null, t1_window: null };
    expect(() => assertTraceable(partial as any, [], ["conditions.0.params.source"])).not.toThrow();
  });
});
