import type { Db } from "@/server/db/pg";
import { insertMany } from "@/server/db/pg";
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
type Raw = Db;
const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");

// ---- benchmarks -----------------------------------------------------------------------------------------------

export async function getUserBenchmarks(raw: Raw, userId: number): Promise<string[]> {
  const rows = await raw.all<{ symbol: string }>("SELECT symbol FROM user_benchmarks WHERE user_id = ? ORDER BY position", [userId]);
  return rows.length ? rows.map((r) => r.symbol) : [...DEFAULT_BENCHMARKS];
}

export async function setUserBenchmarks(raw: Raw, userId: number, symbols: string[]): Promise<string[]> {
  const unique = Array.from(new Set(symbols));
  if (unique.length > MAX_BENCHMARKS) throw new ViewDataError(`at most ${MAX_BENCHMARKS} benchmarks`);
  for (const s of unique) {
    const known = await raw.get<{ kind: string }>("SELECT kind FROM symbols WHERE symbol = ?", [s]);
    if (known ? known.kind !== "index" : !INDEX_TICKER.test(s)) throw new ViewDataError(`${s} is not an index ticker (e.g. ^NSEI)`);
  }
  await raw.tx(async (t) => {
    await insertMany(t, "symbols", ["symbol", "name", "kind", "yahoo_ticker", "active"], unique.map((s) => [s, s, "index", s, 1]), "ON CONFLICT DO NOTHING");
    await t.run("DELETE FROM user_benchmarks WHERE user_id = ?", [userId]);
    await insertMany(t, "user_benchmarks", ["user_id", "symbol", "position"], unique.map((s, i) => [userId, s, i]));
  });
  return unique;
}

const SECTOR_MAP = sectorIndices as unknown as Record<string, { symbol: string; name: string }>;

async function sectorSymbolsForPicks(raw: Raw, watchlistId?: number): Promise<string[]> {
  const rows = await raw.all<{ sector: string }>(
    `SELECT DISTINCT s.sector FROM watchlist_entries e JOIN symbols s ON s.symbol = e.symbol
      WHERE e.membership = 'full_match' AND e.status NOT IN (${marks(CLOSED.length)})
        AND s.sector IS NOT NULL ${watchlistId === undefined ? "" : "AND e.watchlist_id = ?"} ORDER BY s.sector`,
    [...CLOSED, ...(watchlistId === undefined ? [] : [watchlistId])]);
  const out: string[] = [];
  const idxRows: unknown[][] = [];
  for (const { sector } of rows) {
    const idx = SECTOR_MAP[sector];
    if (!idx || sector.startsWith("_")) continue;
    idxRows.push([idx.symbol, idx.name, "index", idx.symbol, 1]);
    out.push(idx.symbol);
  }
  await insertMany(raw, "symbols", ["symbol", "name", "kind", "yahoo_ticker", "active"], idxRows, "ON CONFLICT DO NOTHING");
  return out;
}

export async function benchmarkSymbolsFor(raw: Raw, userId: number, watchlistId: number): Promise<string[]> {
  return Array.from(new Set([...(await getUserBenchmarks(raw, userId)), ...(await sectorSymbolsForPicks(raw, watchlistId))]));
}

// ---- view prefs -----------------------------------------------------------------------------------------------

export const VIEWS = ["screen", "price", "financials", "performance", "risk", "technicals"] as const;
export type ViewId = (typeof VIEWS)[number];
export type ViewPrefs = { view: ViewId; hiddenColumns: Record<string, string[]>; currency: "INR" | "USD"; techTimeframe: Tf; compact: boolean };

export async function getViewPrefs(raw: Raw, userId: number, watchlistId: number): Promise<ViewPrefs> {
  const r = await raw.get("SELECT * FROM user_view_prefs WHERE user_id = ? AND watchlist_id = ?", [userId, watchlistId]);
  if (!r) return { view: "screen", hiddenColumns: {}, currency: "INR", techTimeframe: "1D", compact: false };
  return { view: r.view, hiddenColumns: JSON.parse(r.hidden_columns), currency: r.currency, techTimeframe: r.tech_timeframe, compact: !!r.compact };
}

export async function setViewPrefs(raw: Raw, userId: number, watchlistId: number, patch: Partial<ViewPrefs>): Promise<ViewPrefs> {
  const next = { ...(await getViewPrefs(raw, userId, watchlistId)), ...patch };
  if (!VIEWS.includes(next.view)) throw new ViewDataError(`unknown view: ${next.view}`);
  if (next.currency !== "INR" && next.currency !== "USD") throw new ViewDataError(`unknown currency: ${next.currency}`);
  if (next.techTimeframe !== "1D" && next.techTimeframe !== "1W") throw new ViewDataError(`unknown timeframe: ${next.techTimeframe}`);
  const hidden = next.hiddenColumns;
  if (!hidden || typeof hidden !== "object" || Object.values(hidden).some((v) => !Array.isArray(v) || v.some((c) => typeof c !== "string"))) throw new ViewDataError("hiddenColumns must map a view to column ids");
  await raw.run(
    `INSERT INTO user_view_prefs (user_id, watchlist_id, view, hidden_columns, currency, tech_timeframe, compact) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, watchlist_id) DO UPDATE SET view = excluded.view, hidden_columns = excluded.hidden_columns, currency = excluded.currency,
       tech_timeframe = excluded.tech_timeframe, compact = excluded.compact`,
    [userId, watchlistId, next.view, JSON.stringify(hidden), next.currency, next.techTimeframe, next.compact ? 1 : 0]);
  return next;
}

// ---- compute + store ------------------------------------------------------------------------------------------

async function ensureSymbols(raw: Raw, symbols: string[]) {
  await insertMany(raw, "symbols", ["symbol", "kind", "active"], symbols.map((s) => [s, s.startsWith("^") ? "index" : "stock", 1]), "ON CONFLICT DO NOTHING");
}

const METRIC_COLUMNS = ["symbol", "as_of", "timeframe", "avg_vol_10", "perf_1w", "perf_1m", "perf_3m", "perf_ytd", "perf_1y", "perf_5y", "perf_all", "first_close_date",
  "beta_1y", "beta_3y", "beta_5y", "beta_benchmark", "vol_1d", "vol_1w", "vol_1m", "rsi14", "mom10", "ao", "cci20", "ma_rating", "os_rating", "tech_rating",
  "votes_json", "engine_version", "computed_at"];
// INSERT OR REPLACE: a re-run for the same (symbol, day, timeframe) overwrites every column.
const metricsUpsert = `ON CONFLICT (symbol, as_of, timeframe) DO UPDATE SET ${METRIC_COLUMNS.slice(3).map((c) => `${c} = excluded.${c}`).join(", ")}`;

function metricsRow(symbol: string, tf: Tf, m: RawMetrics): unknown[] {
  return [
    symbol, m.as_of, tf, m.avg_vol_10 ?? null, m.perf_1w ?? null, m.perf_1m ?? null, m.perf_3m ?? null,
    m.perf_ytd ?? null, m.perf_1y ?? null, m.perf_5y ?? null, m.perf_all ?? null, m.first_close_date ?? null,
    m.beta_1y ?? null, m.beta_3y ?? null, m.beta_5y ?? null, m.beta_benchmark ?? null,
    m.vol_1d ?? null, m.vol_1w ?? null, m.vol_1m ?? null, m.rsi14 ?? null, m.mom10 ?? null, m.ao ?? null, m.cci20 ?? null,
    m.ma_rating ?? null, m.os_rating ?? null, m.tech_rating ?? null,
    m.votes ? JSON.stringify(m.votes) : null, ENGINE_METRICS_VERSION, new Date().toISOString(),
  ];
}

const FUNDAMENTAL_COLUMNS = ["symbol", "as_of", "currency", "market_cap", "shares_out", "revenue_ttm", "eps_ttm", "dividend_ttm", "source", "fetched_at", "error"];
const fundamentalsUpsert = `ON CONFLICT (symbol, as_of) DO UPDATE SET ${FUNDAMENTAL_COLUMNS.slice(2).map((c) => `${c} = excluded.${c}`).join(", ")}`;

function fundamentalsRow(symbol: string, today: string, f: RawFundamentals): unknown[] {
  return [symbol, today, f.currency ?? "INR", f.market_cap ?? null, f.shares_out ?? null, f.revenue_ttm ?? null, f.eps_ttm ?? null, f.dividend_ttm ?? null, "yfinance", new Date().toISOString(), f.error ?? null];
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
  await ensureSymbols(raw, unique);
  const failed: Record<string, string> = {};
  let stored = 0;

  for (const batch of chunk(unique, BATCH)) {
    const body = await getMetrics(batch, tf, fetchFn);
    const rows: unknown[][] = [];
    for (const s of batch) {
      const m = body[s];
      if (!m || m.error || !m.as_of) { failed[s] = m?.error ?? "not returned by engine"; continue; }
      rows.push(metricsRow(s, tf, m));
      stored++;
    }
    await insertMany(raw, "symbol_metrics", METRIC_COLUMNS, rows, metricsUpsert);
  }

  // Fundamentals: stocks only, once per day per symbol (errors count as the day's attempt), never on page load.
  const have = new Set((await raw.all<{ symbol: string }>("SELECT symbol FROM symbol_fundamentals WHERE as_of = ?", [today])).map((r) => r.symbol));
  const stocks = unique.filter((s) => !s.startsWith("^") && (opts.force || !have.has(s)));
  for (const batch of chunk(stocks, BATCH)) {
    let body: Record<string, RawFundamentals>;
    try { body = await getFundamentals(batch, fetchFn); } catch (err) { body = Object.fromEntries(batch.map((s) => [s, { error: (err as Error).message }])); }
    await insertMany(raw, "symbol_fundamentals", FUNDAMENTAL_COLUMNS, batch.map((s) => fundamentalsRow(s, today, body[s] ?? { error: "not returned by engine" })), fundamentalsUpsert);
  }
  return { stored, failed };
}

/** Job: every open watchlist entry plus every user's benchmarks (and sector indices), both timeframes. Idempotent. */
export async function computeAllWatchlistMetrics(raw: Raw, opts: { fetchFn?: typeof fetch; today?: string } = {}) {
  const entries = (await raw.all<{ symbol: string }>(`SELECT DISTINCT symbol FROM watchlist_entries WHERE status NOT IN (${marks(CLOSED.length)})`, CLOSED)).map((r) => r.symbol);
  const userBench = (await raw.all<{ symbol: string }>("SELECT DISTINCT symbol FROM user_benchmarks")).map((r) => r.symbol);
  const symbols = Array.from(new Set([...entries, ...DEFAULT_BENCHMARKS, ...userBench, ...(await sectorSymbolsForPicks(raw))]));
  const d1 = await computeMetrics(raw, symbols, { ...opts, tf: "1D" });
  const w1 = await computeMetrics(raw, symbols, { ...opts, tf: "1W" });
  return { symbols: symbols.length, failed: { ...d1.failed, ...w1.failed } };
}

// ---- reads ----------------------------------------------------------------------------------------------------

export async function latestMetrics(raw: Raw, symbol: string, tf: Tf) {
  return raw.get("SELECT * FROM symbol_metrics WHERE symbol = ? AND timeframe = ? ORDER BY as_of DESC LIMIT 1", [symbol, tf]);
}

/** Latest snapshot that did not error — a failed refresh never blanks a row. */
export async function latestFundamentals(raw: Raw, symbol: string) {
  return raw.get("SELECT * FROM symbol_fundamentals WHERE symbol = ? AND error IS NULL ORDER BY as_of DESC LIMIT 1", [symbol]);
}

/** latestMetrics for many symbols in one query per 1000 (a page of 100 rows must not be 200 round trips). */
export async function latestMetricsFor(raw: Raw, symbols: string[], tf: Tf): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  for (const part of chunk(Array.from(new Set(symbols)), 1000)) {
    for (const r of await raw.all(`SELECT DISTINCT ON (symbol) * FROM symbol_metrics WHERE timeframe = ? AND symbol IN (${marks(part.length)}) ORDER BY symbol, as_of DESC`, [tf, ...part])) out.set(r.symbol, r);
  }
  return out;
}

export async function latestFundamentalsFor(raw: Raw, symbols: string[]): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  for (const part of chunk(Array.from(new Set(symbols)), 1000)) {
    for (const r of await raw.all(`SELECT DISTINCT ON (symbol) * FROM symbol_fundamentals WHERE error IS NULL AND symbol IN (${marks(part.length)}) ORDER BY symbol, as_of DESC`, part)) out.set(r.symbol, r);
  }
  return out;
}
