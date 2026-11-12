import { describe, expect, it } from "vitest";
import { convertMoney, fmtCompact, fmtPctSigned, fmtNum } from "@/lib/viewFormat";
import { ratingLabel } from "@/lib/ratings";
import { COLUMNS, visibleColumns } from "@/components/watchlist/columns";
import type { ViewRow } from "@/components/watchlist/viewTypes";

const row = (o: Partial<ViewRow> = {}): ViewRow => ({
  symbol: "AAA.NS", kind: "stock", name: "Aaa", computing: false,
  price: { last: 1000, chg: 12.5, chgPct: 1.27, volume: 5_200_000, avgVol10: 4_100_000, marketCap: 10.56e12, currency: "INR", unit: null },
  financials: { revenue: 9.9e12, eps: 55.5, pe: 18.02, beta: 0.93, dividend: 10, yield: 1.0 },
  performance: { w1: 1.5, m1: -2.25, m3: 3, ytd: 4, y1: 5, y5: null, all: 900, firstCloseDate: "2002-07-01" },
  risk: { beta1y: 0.93, beta3y: 1.1, beta5y: 1.05, benchmark: "^NSEI", vol1d: 0.88, vol1w: 1.61, vol1m: 1.12 },
  technicals: { timeframe: "1D", rsi: 61.234, mom: 12, ao: 3.5, cci: 80, techRating: 0.6, maRating: 0.8, osRating: 0.05, techLabel: "Strong buy", maLabel: "Strong buy", osLabel: "Neutral", votes: null },
  ...o,
});
const INR = { ccy: "INR" as const, usdPerInr: 0.0125 };
const USD = { ccy: "USD" as const, usdPerInr: 0.0125 };
const idx = row({ kind: "index", symbol: "^NSEI", name: "NIFTY 50", price: { ...row().price, last: 25000, marketCap: null, currency: null, unit: "POINT", volume: null } });
const cell = (view: keyof typeof COLUMNS, id: string, r: ViewRow, ctx = INR) => COLUMNS[view].find((c) => c.id === id)!.get(r, ctx);

describe("formatters", () => {
  it("compacts with K/M/B/T and uses a real minus sign", () => {
    expect(fmtCompact(10.56e12)).toBe("10.56 T");
    expect(fmtCompact(4.1e6)).toBe("4.10 M");
    expect(fmtCompact(2500)).toBe("2.50 K");
    expect(fmtCompact(-3.2e9)).toBe("−3.20 B");
    expect(fmtCompact(null)).toBe("—");
    expect(fmtPctSigned(-2.25)).toBe("−2.25%");
    expect(fmtPctSigned(1.5)).toBe("+1.50%");
    expect(fmtNum(1234.5)).toBe("1,234.50");
  });

  it("converts INR to USD by multiplying usdPerInr, and only INR", () => {
    expect(convertMoney(80, "INR", "USD", 0.0125)).toEqual({ value: 1, unit: "USD" });
    expect(convertMoney(80, "INR", "INR", 0.0125)).toEqual({ value: 80, unit: "INR" });
    expect(convertMoney(80, "USD", "USD", 0.0125)).toEqual({ value: 80, unit: "USD" });
    expect(convertMoney(80, "INR", "USD", null).value).toBeNull();
  });

  it("labels rating bands", () => {
    expect([-1, -0.5, -0.1, 0.1, 0.5, 0.51].map(ratingLabel)).toEqual(["Strong sell", "Sell", "Neutral", "Neutral", "Buy", "Strong buy"]);
  });
});

describe("column registry", () => {
  it("has the plan's columns per view, in order", () => {
    const ids = (v: keyof typeof COLUMNS) => COLUMNS[v].map((c) => c.id);
    expect(ids("price")).toEqual(["last", "chgPct", "chg", "volume", "avgVol10", "marketCap"]);
    expect(ids("financials")).toEqual(["revenue", "eps", "pe", "beta", "dividend", "yield"]);
    expect(ids("performance")).toEqual(["w1", "m1", "m3", "ytd", "y1", "y5", "all"]);
    expect(ids("risk")).toEqual(["beta1y", "beta3y", "beta5y", "vol1d", "vol1w", "vol1m"]);
    expect(ids("technicals")).toEqual(["techRating", "maRating", "osRating", "rsi", "mom", "ao", "cci"]);
    for (const cols of Object.values(COLUMNS)) for (const c of cols) { expect(c.label).toBeTruthy(); expect(c.tooltip).toBeTruthy(); }
  });

  it("formats money with compact units and a currency code, indices as POINT", () => {
    expect(cell("price", "marketCap", row()).text).toBe("10.56 T INR");
    expect(cell("financials", "revenue", row()).text).toBe("9.90 T INR");
    expect(cell("price", "last", row()).text).toBe("1,000.00 INR");
    expect(cell("price", "last", idx).text).toBe("25,000.00 POINT");
  });

  it("USD toggle changes money columns only", () => {
    expect(cell("price", "last", row(), USD).text).toBe("12.50 USD");
    expect(cell("price", "marketCap", row(), USD).text).toBe("132.00 B USD");
    expect(cell("financials", "eps", row(), USD).text).toBe("0.69 USD");
    // percentages, ratios, volumes and index points are unchanged
    for (const [v, id] of [["price", "chgPct"], ["price", "volume"], ["financials", "pe"], ["financials", "beta"], ["financials", "yield"], ["performance", "w1"], ["risk", "vol1d"], ["technicals", "rsi"]] as const) {
      expect(cell(v, id, row(), USD)).toEqual(cell(v, id, row(), INR));
    }
    expect(cell("price", "last", idx, USD).text).toBe("25,000.00 POINT");
  });

  it("shows — with the tooltip 'Not applicable to an index' where a metric doesn't apply to an index", () => {
    for (const [v, id] of [["financials", "revenue"], ["financials", "eps"], ["financials", "pe"], ["financials", "dividend"], ["financials", "yield"], ["price", "marketCap"], ["price", "volume"]] as const) {
      expect(cell(v, id, idx)).toMatchObject({ text: "—", title: "Not applicable to an index" });
    }
    expect(cell("performance", "w1", idx).text).not.toBe("—");
  });

  it("a USD view with no FX rate shows — with a reason instead of a wrong number", () => {
    expect(cell("price", "last", row(), { ccy: "USD", usdPerInr: null })).toMatchObject({ text: "—", title: "FX rate unavailable" });
  });

  it("rows still computing show — with 'Computing…'", () => {
    expect(cell("performance", "w1", row({ computing: true }))).toMatchObject({ text: "—", title: "Computing…" });
    expect(cell("technicals", "techRating", row({ computing: true }))).toMatchObject({ text: "—", title: "Computing…" });
  });

  it("ratings are text plus a chevron icon, and carry the 'our implementation' caveat", () => {
    expect(cell("technicals", "techRating", row())).toMatchObject({ text: "Strong buy", icon: "⌃⌃" });
    expect(cell("technicals", "osRating", row())).toMatchObject({ text: "Neutral", icon: "—" });
    expect(cell("technicals", "techRating", row({ technicals: { ...row().technicals, techLabel: "Sell" } }))).toMatchObject({ text: "Sell", icon: "⌄" });
    expect(COLUMNS.technicals[0].tooltip).toMatch(/our implementation of the TradingView rating method/i);
    expect(cell("technicals", "techRating", row()).tone).toBeUndefined();   // never colour alone, and not colour at all
  });

  it("performance signs and colours; All time names its first date", () => {
    expect(cell("performance", "m1", row())).toMatchObject({ text: "−2.25%", tone: "neg" });
    expect(cell("performance", "w1", row())).toMatchObject({ text: "+1.50%", tone: "pos" });
    expect(cell("performance", "y5", row()).text).toBe("—");
    expect(cell("performance", "all", row()).title).toMatch(/2002/);
  });

  it("hidden columns are filtered per view", () => {
    expect(visibleColumns("risk", { risk: ["beta5y"] }).map((c) => c.id)).not.toContain("beta5y");
    expect(visibleColumns("risk", { price: ["last"] })).toHaveLength(6);
    expect(visibleColumns("risk", undefined)).toHaveLength(6);
  });
});
