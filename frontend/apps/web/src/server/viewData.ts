import type Database from "better-sqlite3";
import sectorIndices from "@/config/sector_indices.json";
import { getFundamentals, getMetrics, type RawFundamentals, type RawMetrics } from "@/server/engine/client";

// P6 watchlist views — display-only data (docs/watchlist-views-implementation-plan.md). Nothing in here may be
// imported by screening, selection, grading or compile code (enforced by tests/watchlist-views.test.ts).
export class ViewDataError extends Error {}

export const DEFAULT_BENCHMARKS = ["^NSEI", "^NSEBANK", "^BSESN", "^CNXIT", "^GSPC"];
export const ENGINE_METRICS_VERSION = "metrics-v1";
const CLOSED = ["dropped_from_screen", "stopped_out", "removed_by_user", "closed"];
const MAX_BENCHMARKS = 12;
const BATCH = 50;
const INDEX_TICKER = /^\^[A-Z0-9.\-]{1,20}$/;

type Tf = "1D" | "1W";
type Raw = Database.Database;

// ---- benchmarks -----------------------------------------------------------------------------------------------

export function getUserBenchmarks(raw: Raw, userId: number): string[] {
  const rows = raw.prepare("SELECT symbol FROM user_benchmarks WHERE user_id = ? ORDER BY position").all(userId) as { symbol: string }[];
  return rows.length ? rows.map((r) => r.symbol) : [...DEFAULT_BENCHMARKS];
}

export function setUserBenchmarks(raw: Raw, userId: number, symbols: string[]): string[] {
  const unique = Array.from(new Set(symbols));
  if (unique.length > MAX_BENCHMARKS) throw new ViewDataError(`at most ${MAX_BENCHMARKS} benchmarks`);
  for (const s of unique) {
    const known = raw.prepare("SELECT kind FROM symbols WHERE symbol = ?").get(s) as { kind: string } | undefined;
    if (known ? known.kind !== "index" : !INDEX_TICKER.test(s)) throw new ViewDataError(`${s} is not an index ticker (e.g. ^NSEI)`);
  }
  raw.transaction(() => {
    const ins = raw.prepare("INSERT OR IGNORE INTO symbols (symbol, name, kind, yahoo_ticker, active) VALUES (?, ?, 'index', ?, 1)");
    for (const s of unique) ins.run(s, s, s);
    raw.prepare("DELETE FROM user_benchmarks WHERE user_id = ?").run(userId);
    const put = raw.prepare("INSERT INTO user_benchmarks (user_id, symbol, position) VALUES (?, ?, ?)");
    unique.forEach((s, i) => put.run(userId, s, i));
  })();
  return unique;
}

const SECTOR_MAP = sectorIndices as unknown as Record<string, { symbol: string; name: string }>;

function sectorSymbolsForPicks(raw: Raw, watchlistId?: number): string[] {
  const rows = raw.prepare(
    `SELECT DISTINCT s.sector FROM watchlist_entries e JOIN symbols s ON s.symbol = e.symbol
      WHERE e.membership = 'full_match' AND e.status NOT IN (${CLOSED.map(() => "?").join(",")})
        AND s.sector IS NOT NULL ${watchlistId === undefined ? "" : "AND e.watchlist_id = ?"} ORDER BY s.sector`
  ).all(...CLOSED, ...(watchlistId === undefined ? [] : [watchlistId])) as { sector: string }[];
  const ins = raw.prepare("INSERT OR IGNORE INTO symbols (symbol, name, kind, yahoo_ticker, active) VALUES (?, ?, 'index', ?, 1)");
  const out: string[] = [];
  for (const { sector } of rows) {
    const idx = SECTOR_MAP[sector];
    if (!idx || sector.startsWith("_")) continue;
    ins.run(idx.symbol, idx.name, idx.symbol);
    out.push(idx.symbol);
  }
  return out;
}

export function benchmarkSymbolsFor(raw: Raw, userId: number, watchlistId: number): string[] {
  return Array.from(new Set([...getUserBenchmarks(raw, userId), ...sectorSymbolsForPicks(raw, watchlistId)]));
}

// ---- view prefs -----------------------------------------------------------------------------------------------

export const VIEWS = ["screen", "price", "financials", "performance", "risk", "technicals"] as const;
export type ViewId = (typeof VIEWS)[number];
export type ViewPrefs = { view: ViewId; hiddenColumns: Record<string, string[]>; currency: "INR" | "USD"; techTimeframe: Tf; compact: boolean };

export function getViewPrefs(raw: Raw, userId: number, watchlistId: number): ViewPrefs {
  const r = raw.prepare("SELECT * FROM user_view_prefs WHERE user_id = ? AND watchlist_id = ?").get(userId, watchlistId) as any;
  if (!r) return { view: "screen", hiddenColumns: {}, currency: "INR", techTimeframe: "1D", compact: false };
  return { view: r.view, hiddenColumns: JSON.parse(r.hidden_columns), currency: r.currency, techTimeframe: r.tech_timeframe, compact: !!r.compact };
}

export function setViewPrefs(raw: Raw, userId: number, watchlistId: number, patch: Partial<ViewPrefs>): ViewPrefs {
  const next = { ...getViewPrefs(raw, userId, watchlistId), ...patch };
  if (!VIEWS.includes(next.view)) throw new ViewDataError(`unknown view: ${next.view}`);
  if (next.currency !== "INR" && next.currency !== "USD") throw new ViewDataError(`unknown currency: ${next.currency}`);
  if (next.techTimeframe !== "1D" && next.techTimeframe !== "1W") throw new ViewDataError(`unknown timeframe: ${next.techTimeframe}`);
  const hidden = next.hiddenColumns;
  if (!hidden || typeof hidden !== "object" || Object.values(hidden).some((v) => !Array.isArray(v) || v.some((c) => typeof c !== "string"))) throw new ViewDataError("hiddenColumns must map a view to column ids");
  raw.prepare(
    `INSERT INTO user_view_prefs (user_id, watchlist_id, view, hidden_columns, currency, tech_timeframe, compact) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, watchlist_id) DO UPDATE SET view = excluded.view, hidden_columns = excluded.hidden_columns, currency = excluded.currency,
       tech_timeframe = excluded.tech_timeframe, compact = excluded.compact`
  ).run(userId, watchlistId, next.view, JSON.stringify(hidden), next.currency, next.techTimeframe, next.compact ? 1 : 0);
  return next;
}

// ---- compute + store ------------------------------------------------------------------------------------------

function ensureSymbols(raw: Raw, symbols: string[]) {
  const ins = raw.prepare("INSERT OR IGNORE INTO symbols (symbol, kind, active) VALUES (?, ?, 1)");
  for (const s of symbols) ins.run(s, s.startsWith("^") ? "index" : "stock");
}

function storeMetrics(raw: Raw, symbol: string, tf: Tf, m: RawMetrics) {
  raw.prepare(
    `INSERT OR REPLACE INTO symbol_metrics (symbol, as_of, timeframe, avg_vol_10, perf_1w, perf_1m, perf_3m, perf_ytd, perf_1y, perf_5y, perf_all, first_close_date,
       beta_1y, beta_3y, beta_5y, beta_benchmark, vol_1d, vol_1w, vol_1m, rsi14, mom10, ao, cci20, ma_rating, os_rating, tech_rating, votes_json, engine_version, computed_at)
     VALUES (@symbol, @as_of, @tf, @avg_vol_10, @perf_1w, @perf_1m, @perf_3m, @perf_ytd, @perf_1y, @perf_5y, @perf_all, @first_close_date,
       @beta_1y, @beta_3y, @beta_5y, @beta_benchmark, @vol_1d, @vol_1w, @vol_1m, @rsi14, @mom10, @ao, @cci20, @ma_rating, @os_rating, @tech_rating, @votes_json, @engine_version, @computed_at)`
  ).run({
    symbol, tf, as_of: m.as_of, avg_vol_10: m.avg_vol_10 ?? null, perf_1w: m.perf_1w ?? null, perf_1m: m.perf_1m ?? null, perf_3m: m.perf_3m ?? null,
    perf_ytd: m.perf_ytd ?? null, perf_1y: m.perf_1y ?? null, perf_5y: m.perf_5y ?? null, perf_all: m.perf_all ?? null, first_close_date: m.first_close_date ?? null,
    beta_1y: m.beta_1y ?? null, beta_3y: m.beta_3y ?? null, beta_5y: m.beta_5y ?? null, beta_benchmark: m.beta_benchmark ?? null,
    vol_1d: m.vol_1d ?? null, vol_1w: m.vol_1w ?? null, vol_1m: m.vol_1m ?? null, rsi14: m.rsi14 ?? null, mom10: m.mom10 ?? null, ao: m.ao ?? null, cci20: m.cci20 ?? null,
    ma_rating: m.ma_rating ?? null, os_rating: m.os_rating ?? null, tech_rating: m.tech_rating ?? null,
    votes_json: m.votes ? JSON.stringify(m.votes) : null, engine_version: ENGINE_METRICS_VERSION, computed_at: new Date().toISOString(),
  });
}

function storeFundamentals(raw: Raw, symbol: string, today: string, f: RawFundamentals) {
  raw.prepare(
    `INSERT OR REPLACE INTO symbol_fundamentals (symbol, as_of, currency, market_cap, shares_out, revenue_ttm, eps_ttm, dividend_ttm, source, fetched_at, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'yfinance', ?, ?)`
  ).run(symbol, today, f.currency ?? "INR", f.market_cap ?? null, f.shares_out ?? null, f.revenue_ttm ?? null, f.eps_ttm ?? null, f.dividend_ttm ?? null, new Date().toISOString(), f.error ?? null);
}

const chunk = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export async function computeMetrics(
  raw: Raw, symbols: string[],
  opts: { fetchFn?: typeof fetch; today?: string; tf?: Tf; force?: boolean } = {}
): Promise<{ stored: number; failed: Record<string, string> }> {
  const fetchFn = opts.fetchFn ?? fetch;
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const tf = opts.tf ?? "1D";
  const unique = Array.from(new Set(symbols));
  ensureSymbols(raw, unique);
  const failed: Record<string, string> = {};
  let stored = 0;

  for (const batch of chunk(unique, BATCH)) {
    const body = await getMetrics(batch, tf, fetchFn);
    raw.transaction(() => {
      for (const s of batch) {
        const m = body[s];
        if (!m || m.error || !m.as_of) { failed[s] = m?.error ?? "not returned by engine"; continue; }
        storeMetrics(raw, s, tf, m);
        stored++;
      }
    })();
  }

  // Fundamentals: stocks only, once per day per symbol (errors count as the day's attempt), never on page load.
  const have = new Set((raw.prepare("SELECT symbol FROM symbol_fundamentals WHERE as_of = ?").all(today) as { symbol: string }[]).map((r) => r.symbol));
  const stocks = unique.filter((s) => !s.startsWith("^") && (opts.force || !have.has(s)));
  for (const batch of chunk(stocks, BATCH)) {
    let body: Record<string, RawFundamentals>;
    try { body = await getFundamentals(batch, fetchFn); } catch (err) { body = Object.fromEntries(batch.map((s) => [s, { error: (err as Error).message }])); }
    raw.transaction(() => { for (const s of batch) storeFundamentals(raw, s, today, body[s] ?? { error: "not returned by engine" }); })();
  }
  return { stored, failed };
}

/** Job: every open watchlist entry plus every user's benchmarks (and sector indices), both timeframes. Idempotent. */
export async function computeAllWatchlistMetrics(raw: Raw, opts: { fetchFn?: typeof fetch; today?: string } = {}) {
  const entries = (raw.prepare(`SELECT DISTINCT symbol FROM watchlist_entries WHERE status NOT IN (${CLOSED.map(() => "?").join(",")})`).all(...CLOSED) as { symbol: string }[]).map((r) => r.symbol);
  const userBench = (raw.prepare("SELECT DISTINCT symbol FROM user_benchmarks").all() as { symbol: string }[]).map((r) => r.symbol);
  const symbols = Array.from(new Set([...entries, ...DEFAULT_BENCHMARKS, ...userBench, ...sectorSymbolsForPicks(raw)]));
  const d1 = await computeMetrics(raw, symbols, { ...opts, tf: "1D" });
  const w1 = await computeMetrics(raw, symbols, { ...opts, tf: "1W" });
  return { symbols: symbols.length, failed: { ...d1.failed, ...w1.failed } };
}

// ---- reads ----------------------------------------------------------------------------------------------------

export function latestMetrics(raw: Raw, symbol: string, tf: Tf) {
  return raw.prepare("SELECT * FROM symbol_metrics WHERE symbol = ? AND timeframe = ? ORDER BY as_of DESC LIMIT 1").get(symbol, tf) as any | undefined;
}

/** Latest snapshot that did not error — a failed refresh never blanks a row. */
export function latestFundamentals(raw: Raw, symbol: string) {
  return raw.prepare("SELECT * FROM symbol_fundamentals WHERE symbol = ? AND error IS NULL ORDER BY as_of DESC LIMIT 1").get(symbol) as any | undefined;
}
