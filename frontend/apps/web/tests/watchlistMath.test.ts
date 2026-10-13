import { describe, expect, it } from "vitest";
import { computeKpis, fmtDate, fmtSignedPct, newestAsOf, sinceEntry, addDays } from "@/lib/watchlistMath";

const e = (o: any) => ({ entryId: 1, symbol: "A", membership: "full_match", status: "entered", entryPrice: 100, refPrice: null, ...o });

describe("watchlistMath", () => {
  it("signs returns so colour is never the only cue", () => {
    expect(fmtSignedPct(2.34)).toBe("+2.3%");
    expect(fmtSignedPct(-0.5)).toBe("−0.5%");
    expect(fmtSignedPct(null)).toBe("—");
  });
  it("formats dates from data, weekday optional", () => {
    expect(fmtDate("2026-10-02")).toBe("2 Oct");
    expect(fmtDate("2026-10-02", true)).toBe("Fri 2 Oct");
    expect(addDays("2026-10-02", 7)).toBe("2026-10-09");
  });
  it("since entry: entered vs entry, shadow vs ref, pending none", () => {
    expect(sinceEntry(e({}), { price: 110, asOf: null, error: null })).toEqual({ pct: 10, ref: false });
    expect(sinceEntry(e({ membership: "near_miss", status: "watching", entryPrice: null, refPrice: 50 }), { price: 55, asOf: null, error: null })).toEqual({ pct: 10, ref: true });
    expect(sinceEntry(e({ status: "pending_selection" }), { price: 110, asOf: null, error: null })).toBeNull();
    expect(sinceEntry(e({}), undefined)).toBeNull();
  });
  it("prices-as-of is the newest quote timestamp, not the wall clock", () => {
    expect(newestAsOf({ A: { price: 1, asOf: "2026-10-02T09:15:00Z", error: null }, B: { price: 1, asOf: "2026-10-02T09:20:00Z", error: null }, C: { price: null, asOf: null, error: "x" } })).toBe("2026-10-02T09:20:00Z");
    expect(newestAsOf({})).toBeNull();
  });
  it("KPIs: equal-weight avg over entered picks only; third slot follows U2", () => {
    const entries = [e({ entryId: 1, symbol: "A" }), e({ entryId: 2, symbol: "B", entryPrice: 200 }), e({ entryId: 3, symbol: "C", status: "pending_selection", entryPrice: null }), e({ entryId: 4, symbol: "D", membership: "near_miss", status: "watching", entryPrice: null })];
    const q = { A: { price: 110, asOf: null, error: null }, B: { price: 190, asOf: null, error: null } };
    const k = computeKpis(entries, q, true);
    expect(k.picks).toEqual({ value: 3, note: "2 entered · 1 pending" });
    expect(k.avgSinceEntry.value).toBeCloseTo(2.5);
    expect(k.avgSinceEntry.n).toBe(2);
    expect(k.third.label).toBe("Shadow on watchlist");
    expect(computeKpis(entries, q, false).third.label).toBe("Unevaluated");
    expect(computeKpis([], {}, false).avgSinceEntry.value).toBeNull();
  });
});
