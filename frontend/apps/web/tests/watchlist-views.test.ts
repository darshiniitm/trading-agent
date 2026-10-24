import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createTestDb } from "@/server/db/test-db";
import { seedUiDemo } from "@/server/db/seed";
import {
  DEFAULT_BENCHMARKS, getUserBenchmarks, setUserBenchmarks, benchmarkSymbolsFor, getViewPrefs, setViewPrefs,
  computeMetrics, computeAllWatchlistMetrics, ViewDataError,
} from "@/server/viewData";
import { buildWatchlistViews } from "@/server/views";

function demo() {
  const raw = createTestDb();
  seedUiDemo(raw);
  return raw;
}

const METRICS = (over: Record<string, unknown> = {}) => ({
  as_of: "2026-10-14", timeframe: "1D", avg_vol_10: 1000, perf_1w: 1.5, perf_1m: 2, perf_3m: 3, perf_ytd: 4, perf_1y: 5, perf_5y: null,
  perf_all: 50, first_close_date: "2010-01-04", beta_1y: 1.1, beta_3y: 1.0, beta_5y: 0.9, beta_benchmark: "^NSEI",
  vol_1d: 0.9, vol_1w: 1.6, vol_1m: 1.1, rsi14: 60, mom10: 5, ao: 3, cci20: 80, ma_rating: 0.6, os_rating: 0.1, tech_rating: 0.35,
  votes: { ma: { SMA10: 1 }, os: { RSI: 0 } }, ...over,
});
const FUND = (over: Record<string, unknown> = {}) => ({ currency: "INR", market_cap: 1e11, shares_out: 1e9, revenue_ttm: 5e10, eps_ttm: 10, dividend_ttm: 2, ...over });

function engine(opts: { metrics?: (syms: string[], tf: string) => Record<string, unknown>; fund?: (syms: string[]) => Record<string, unknown> } = {}) {
  return vi.fn(async (url: string) => {
    const u = new URL(url);
    const syms = (u.searchParams.get("symbols") ?? "").split(",");
    const body = u.pathname === "/metrics"
      ? (opts.metrics ? opts.metrics(syms, u.searchParams.get("tf")!) : Object.fromEntries(syms.map((s) => [s, METRICS()])))
      : (opts.fund ? opts.fund(syms) : Object.fromEntries(syms.map((s) => [s, FUND()])));
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("schema", () => {
  it("seeds the five default benchmarks as index symbols", () => {
    const raw = demo();
    const idx = raw.prepare("SELECT symbol FROM symbols WHERE kind = 'index' ORDER BY symbol").all().map((r: any) => r.symbol);
    expect(idx).toEqual(["^BSESN", "^CNXIT", "^GSPC", "^NSEBANK", "^NSEI"]);
    expect(raw.prepare("SELECT kind FROM symbols WHERE symbol = 'AAA.NS'").get()).toEqual({ kind: "stock" });
  });
});

describe("benchmarks", () => {
  it("defaults to the five indices and is stored per user once set", () => {
    const raw = demo();
    expect(getUserBenchmarks(raw, 1)).toEqual(DEFAULT_BENCHMARKS);
    expect(setUserBenchmarks(raw, 1, ["^NSEI", "^GSPC"])).toEqual(["^NSEI", "^GSPC"]);
    expect(getUserBenchmarks(raw, 1)).toEqual(["^NSEI", "^GSPC"]);
    expect(getUserBenchmarks(raw, 2)).toEqual(DEFAULT_BENCHMARKS);
  });

  it("accepts a new index ticker, rejects stocks, junk and oversized lists", () => {
    const raw = demo();
    expect(setUserBenchmarks(raw, 1, ["^NSEI", "^CNXAUTO"])).toContain("^CNXAUTO");
    expect(() => setUserBenchmarks(raw, 1, ["AAA.NS"])).toThrow(ViewDataError);
    expect(() => setUserBenchmarks(raw, 1, ["^bad ticker!"])).toThrow(ViewDataError);
    expect(() => setUserBenchmarks(raw, 1, Array.from({ length: 13 }, (_, i) => `^X${i}`))).toThrow(ViewDataError);
  });

  it("adds the Nifty sector index of every sector that has an open pick, once", () => {
    const raw = demo();
    raw.prepare("UPDATE symbols SET sector = 'Information Technology' WHERE symbol IN ('AAA.NS','BBB.NS')").run();
    const syms = benchmarkSymbolsFor(raw, 1, 1);
    expect(syms.slice(0, 5)).toEqual(DEFAULT_BENCHMARKS);
    expect(syms.filter((s) => s === "^CNXIT")).toHaveLength(1);   // already a default: no duplicate
    raw.prepare("UPDATE symbols SET sector = 'Realty' WHERE symbol = 'AAA.NS'").run();
    expect(benchmarkSymbolsFor(raw, 1, 1)).toContain("^CNXREALTY");
  });
});

describe("view prefs", () => {
  it("defaults to the Screen view in INR/1D and round-trips a patch", () => {
    const raw = demo();
    expect(getViewPrefs(raw, 1, 1)).toEqual({ view: "screen", hiddenColumns: {}, currency: "INR", techTimeframe: "1D", compact: false });
    const next = setViewPrefs(raw, 1, 1, { view: "risk", currency: "USD", hiddenColumns: { risk: ["beta_5y"] } });
    expect(next).toMatchObject({ view: "risk", currency: "USD", hiddenColumns: { risk: ["beta_5y"] }, techTimeframe: "1D" });
    expect(getViewPrefs(raw, 1, 1)).toEqual(next);
    expect(getViewPrefs(raw, 2, 1).view).toBe("screen");
  });

  it("rejects unknown views, currencies and timeframes", () => {
    const raw = demo();
    expect(() => setViewPrefs(raw, 1, 1, { view: "nope" as any })).toThrow(ViewDataError);
    expect(() => setViewPrefs(raw, 1, 1, { currency: "EUR" as any })).toThrow(ViewDataError);
    expect(() => setViewPrefs(raw, 1, 1, { techTimeframe: "1M" as any })).toThrow(ViewDataError);
  });
});

describe("computeMetrics", () => {
  it("stores metrics and fundamentals, fundamentals for stocks only, and is idempotent", async () => {
    const raw = demo();
    const fetchFn = engine();
    await computeMetrics(raw, ["AAA.NS", "^NSEI"], { fetchFn, today: "2026-10-15" });
    await computeMetrics(raw, ["AAA.NS", "^NSEI"], { fetchFn, today: "2026-10-15" });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM symbol_metrics WHERE timeframe = '1D'").get()).toEqual({ n: 2 });
    expect(raw.prepare("SELECT symbol FROM symbol_fundamentals").all()).toEqual([{ symbol: "AAA.NS" }]);
    const row = raw.prepare("SELECT * FROM symbol_metrics WHERE symbol = 'AAA.NS'").get() as any;
    expect(row).toMatchObject({ as_of: "2026-10-14", rsi14: 60, tech_rating: 0.35, beta_benchmark: "^NSEI" });
    expect(JSON.parse(row.votes_json)).toEqual({ ma: { SMA10: 1 }, os: { RSI: 0 } });
    // the second call must not refetch today's fundamentals
    const fundCalls = (fetchFn as any).mock.calls.filter((c: any[]) => c[0].includes("/fundamentals")).length;
    expect(fundCalls).toBe(1);
  });

  it("isolates a per-symbol engine error and never stores a blank metrics row for it", async () => {
    const raw = demo();
    const fetchFn = engine({ metrics: (syms) => Object.fromEntries(syms.map((s) => [s, s === "BBB.NS" ? { error: "no price history" } : METRICS()])) });
    const res = await computeMetrics(raw, ["AAA.NS", "BBB.NS"], { fetchFn, today: "2026-10-15" });
    expect(res.failed).toEqual({ "BBB.NS": "no price history" });
    expect(raw.prepare("SELECT symbol FROM symbol_metrics").all()).toEqual([{ symbol: "AAA.NS" }]);
  });

  it("a failed fundamentals fetch writes an error row and keeps serving the previous snapshot", async () => {
    const raw = demo();
    await computeMetrics(raw, ["AAA.NS"], { fetchFn: engine(), today: "2026-10-14" });
    await computeMetrics(raw, ["AAA.NS"], { fetchFn: engine({ fund: (s) => Object.fromEntries(s.map((x) => [x, { error: "rate limited" }])) }), today: "2026-10-15" });
    const rows = raw.prepare("SELECT as_of, error FROM symbol_fundamentals ORDER BY as_of").all();
    expect(rows).toEqual([{ as_of: "2026-10-14", error: null }, { as_of: "2026-10-15", error: "rate limited" }]);
    const views = buildWatchlistViews(raw, 1, 1, { tf: "1D", quotes: {}, fx: null });
    const aaa = views.sections.flatMap((s: any) => s.rows).find((r: any) => r.symbol === "AAA.NS");
    expect(aaa.financials.eps).toBe(10);
    expect(views.asOf.fundamentals).toBe("2026-10-14");
  });

  it("computeAll covers open entries plus every benchmark, in both timeframes", async () => {
    const raw = demo();
    raw.prepare("UPDATE watchlist_entries SET status = 'removed_by_user' WHERE symbol = 'CCC.NS'").run();
    const fetchFn = engine();
    await computeAllWatchlistMetrics(raw, { fetchFn, today: "2026-10-15" });
    const syms = raw.prepare("SELECT DISTINCT symbol FROM symbol_metrics ORDER BY symbol").all().map((r: any) => r.symbol);
    // defaults + the sector index of each sector with an open pick (Industrials, Healthcare)
    expect(syms).toEqual(["AAA.NS", "BBB.NS", "^BSESN", "^CNXINFRA", "^CNXIT", "^CNXPHARMA", "^GSPC", "^NSEBANK", "^NSEI"]);
    expect(raw.prepare("SELECT DISTINCT timeframe FROM symbol_metrics ORDER BY 1").all()).toEqual([{ timeframe: "1D" }, { timeframe: "1W" }]);
  });
});

describe("buildWatchlistViews", () => {
  const quotes = {
    "AAA.NS": { price: 120, asOf: "2026-10-15T09:30:00Z", error: null, chgPct: 2, chg: 2.35, volume: 5000 },
    "^NSEI": { price: 25000, asOf: "2026-10-15T09:30:00Z", error: null, chgPct: 0.5, chg: 125 },
  };

  it("orders sections Benchmarks -> Arm picks -> Watching/shadow -> Dropped and pins benchmarks without status", async () => {
    const raw = demo();
    raw.prepare("INSERT OR IGNORE INTO symbols (symbol, name) VALUES ('DDD.NS', 'Ddd')").run();
    raw.prepare("INSERT INTO watchlist_entries (watchlist_id, symbol, first_run_id, last_run_id, membership, status, created_at, updated_at) VALUES (1, 'CCC.NS', 10, 10, 'full_match', 'dropped_from_screen', 'x', 'x')").run();
    raw.prepare("DELETE FROM watchlist_entries WHERE entry_id = 3").run();
    raw.prepare("INSERT INTO watchlist_entries (entry_id, watchlist_id, symbol, first_run_id, last_run_id, membership, status, created_at, updated_at) VALUES (3, 1, 'DDD.NS', 11, 11, 'near_miss', 'watching', 'x', 'x')").run();
    await computeMetrics(raw, ["AAA.NS", "BBB.NS", "DDD.NS", "^NSEI"], { fetchFn: engine(), today: "2026-10-15" });
    const v = buildWatchlistViews(raw, 1, 1, { tf: "1D", quotes, fx: null });
    expect(v.sections.map((s: any) => s.id)).toEqual(["benchmarks", "picks", "watching", "dropped"]);
    const bench = v.sections[0];
    expect(bench.rows.map((r: any) => r.symbol).slice(0, 5)).toEqual(DEFAULT_BENCHMARKS);
    for (const r of bench.rows as any[]) { expect(r.kind).toBe("index"); expect(r.status).toBeUndefined(); expect(r.entryId).toBeUndefined(); }
    expect(v.sections[1].rows.map((r: any) => r.symbol)).toEqual(["AAA.NS", "BBB.NS"]);
    expect(v.sections[3].collapsedByDefault).toBe(true);
  });

  it("omits the watching section when there are no shadow rows, and never lists removed entries", () => {
    const raw = demo();
    raw.prepare("UPDATE watchlist_entries SET status = 'removed_by_user' WHERE symbol = 'CCC.NS'").run();
    const v = buildWatchlistViews(raw, 1, 1, { tf: "1D", quotes: {}, fx: null });
    expect(v.sections.map((s: any) => s.id)).toEqual(["benchmarks", "picks"]);
    expect(v.sections.flatMap((s: any) => s.rows).some((r: any) => r.symbol === "CCC.NS")).toBe(false);
  });

  it("derives P/E, yield and market cap from stored fundamentals and the live quote; blanks P/E when EPS <= 0", async () => {
    const raw = demo();
    await computeMetrics(raw, ["AAA.NS", "BBB.NS"], {
      fetchFn: engine({ fund: (s) => Object.fromEntries(s.map((x) => [x, x === "BBB.NS" ? FUND({ eps_ttm: -2 }) : FUND()])) }), today: "2026-10-14",
    });
    const v = buildWatchlistViews(raw, 1, 1, { tf: "1D", quotes, fx: null });
    const rows = Object.fromEntries(v.sections.flatMap((s: any) => s.rows).map((r: any) => [r.symbol, r]));
    expect(rows["AAA.NS"].financials.pe).toBeCloseTo(12);                       // 120 / 10
    expect(rows["AAA.NS"].financials.yield).toBeCloseTo((2 / 120) * 100);
    expect(rows["AAA.NS"].price.marketCap).toBeCloseTo(1e9 * 120);              // quote is newer than the snapshot
    expect(rows["AAA.NS"].price.volume).toBe(5000);
    expect(rows["AAA.NS"].price.avgVol10).toBe(1000);
    expect(rows["AAA.NS"].financials.beta).toBe(1.1);
    expect(rows["BBB.NS"].financials.pe).toBeNull();
    expect(rows["^NSEI"].financials).toMatchObject({ eps: null, pe: null, revenue: null });
  });

  it("flags rows with no computed metrics as computing, and reports as-of dates for every source", async () => {
    const raw = demo();
    await computeMetrics(raw, ["AAA.NS"], { fetchFn: engine(), today: "2026-10-15" });
    const v = buildWatchlistViews(raw, 1, 1, { tf: "1D", quotes, fx: { inrPerUsd: 80, usdPerInr: 0.0125, asOf: "2026-10-15T09:30:00Z" } });
    const rows = Object.fromEntries(v.sections.flatMap((s: any) => s.rows).map((r: any) => [r.symbol, r]));
    expect(rows["AAA.NS"].computing).toBe(false);
    expect(rows["BBB.NS"].computing).toBe(true);
    expect(v.missingSymbols).toContain("BBB.NS");
    expect(v.asOf).toMatchObject({ metrics: "2026-10-14", quotes: "2026-10-15T09:30:00Z", fx: "2026-10-15T09:30:00Z" });
    expect(v.fx).toEqual({ inrPerUsd: 80, usdPerInr: 0.0125, asOf: "2026-10-15T09:30:00Z" });
  });

  it("uses the requested timeframe's technicals and keeps the other timeframe's out of the payload", async () => {
    const raw = demo();
    await computeMetrics(raw, ["AAA.NS"], { fetchFn: engine({ metrics: (s, tf) => Object.fromEntries(s.map((x) => [x, METRICS({ timeframe: tf, rsi14: tf === "1W" ? 44 : 60 })])) }), today: "2026-10-15" });
    await computeMetrics(raw, ["AAA.NS"], { fetchFn: engine({ metrics: (s, tf) => Object.fromEntries(s.map((x) => [x, METRICS({ timeframe: tf, rsi14: tf === "1W" ? 44 : 60 })])) }), today: "2026-10-15", tf: "1W" });
    const find = (v: any) => v.sections.flatMap((s: any) => s.rows).find((r: any) => r.symbol === "AAA.NS");
    expect(find(buildWatchlistViews(raw, 1, 1, { tf: "1D", quotes: {}, fx: null })).technicals.rsi).toBe(60);
    expect(find(buildWatchlistViews(raw, 1, 1, { tf: "1W", quotes: {}, fx: null })).technicals.rsi).toBe(44);
  });
});

describe("isolation (plan §9)", () => {
  it("no screening, selection, grading or compile code imports the view data modules", () => {
    const root = path.join(process.cwd(), "src", "server");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) { walk(p); continue; }
        if (!/\.ts$/.test(f.name) || ["viewData.ts", "views.ts", "viewsApi.ts"].includes(f.name)) continue;
        if (/@\/server\/(viewData|views|viewsApi)\b|["']\.\/(viewData|views|viewsApi)["']|symbol_metrics|symbol_fundamentals/.test(fs.readFileSync(p, "utf8"))) offenders.push(path.relative(root, p));
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
