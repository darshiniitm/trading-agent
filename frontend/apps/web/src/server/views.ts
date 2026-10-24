import type Database from "better-sqlite3";
import { ratingLabel } from "@/lib/ratings";
import { benchmarkSymbolsFor, latestFundamentals, latestMetrics } from "@/server/viewData";
import type { Quote } from "@/server/quotes";

// P6: the read model behind GET /api/watchlists/:id/views. DISPLAY ONLY — values here never feed conditions,
// weeklyScreen, selectEntry, validatePrior or any grading path.
export type Fx = { inrPerUsd: number; usdPerInr: number; asOf: string | null };
const DROPPED = ["dropped_from_screen", "stopped_out", "closed"];
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

function rowFor(raw: Database.Database, symbol: string, meta: { name: string | null; kind: string }, tf: "1D" | "1W", quote: Quote | undefined) {
  const m = latestMetrics(raw, symbol, tf);
  const isIndex = meta.kind === "index";
  const f = isIndex ? undefined : latestFundamentals(raw, symbol);
  const last = quote && quote.price !== null && !quote.error ? quote.price : null;
  const eps = num(f?.eps_ttm);
  const dividend = num(f?.dividend_ttm);
  const quoteIsNewer = !!(quote?.asOf && f && quote.asOf.slice(0, 10) > f.as_of);
  const marketCap = f ? (quoteIsNewer && last !== null && num(f.shares_out) ? f.shares_out * last : num(f.market_cap)) : null;
  const techRating = num(m?.tech_rating), maRating = num(m?.ma_rating), osRating = num(m?.os_rating);
  return {
    symbol, kind: meta.kind, name: meta.name, computing: !m,
    price: {
      last, chg: num(quote?.chg), chgPct: num(quote?.chgPct), volume: isIndex ? null : num(quote?.volume),
      avgVol10: num(m?.avg_vol_10), marketCap: isIndex ? null : marketCap, currency: isIndex ? null : (f?.currency ?? "INR"), unit: isIndex ? "POINT" : null,
    },
    financials: {
      revenue: num(f?.revenue_ttm), eps, pe: eps !== null && eps > 0 && last !== null ? last / eps : null,
      beta: num(m?.beta_1y), dividend, yield: dividend !== null && last ? (dividend / last) * 100 : null,
    },
    performance: {
      w1: num(m?.perf_1w), m1: num(m?.perf_1m), m3: num(m?.perf_3m), ytd: num(m?.perf_ytd), y1: num(m?.perf_1y), y5: num(m?.perf_5y),
      all: num(m?.perf_all), firstCloseDate: m?.first_close_date ?? null,
    },
    risk: {
      beta1y: num(m?.beta_1y), beta3y: num(m?.beta_3y), beta5y: num(m?.beta_5y), benchmark: m?.beta_benchmark ?? null,
      vol1d: num(m?.vol_1d), vol1w: num(m?.vol_1w), vol1m: num(m?.vol_1m),
    },
    technicals: {
      timeframe: tf, rsi: num(m?.rsi14), mom: num(m?.mom10), ao: num(m?.ao), cci: num(m?.cci20),
      techRating, maRating, osRating, techLabel: ratingLabel(techRating), maLabel: ratingLabel(maRating), osLabel: ratingLabel(osRating),
      votes: m?.votes_json ? JSON.parse(m.votes_json) : null,
    },
    _metricsAsOf: m?.as_of ?? null, _fundamentalsAsOf: f?.as_of ?? null,
  };
}

export function buildWatchlistViews(raw: Database.Database, watchlistId: number, userId: number, opts: { tf: "1D" | "1W"; quotes: Record<string, Quote>; fx: Fx | null }) {
  const symbolMeta = raw.prepare("SELECT name, kind FROM symbols WHERE symbol = ?");
  const meta = (s: string) => (symbolMeta.get(s) as { name: string | null; kind: string } | undefined) ?? { name: null, kind: s.startsWith("^") ? "index" : "stock" };

  const entries = raw.prepare("SELECT * FROM watchlist_entries WHERE watchlist_id = ? AND status <> 'removed_by_user' ORDER BY symbol, entry_id").all(watchlistId) as any[];
  const entryRow = (e: any) => ({ ...rowFor(raw, e.symbol, meta(e.symbol), opts.tf, opts.quotes[e.symbol]), entryId: e.entry_id, status: e.status, membership: e.membership });

  const benchRows = benchmarkSymbolsFor(raw, userId, watchlistId).map((s) => rowFor(raw, s, meta(s), opts.tf, opts.quotes[s]));
  const picks = entries.filter((e) => !DROPPED.includes(e.status) && e.membership === "full_match").map(entryRow);
  const watching = entries.filter((e) => !DROPPED.includes(e.status) && e.membership !== "full_match").map(entryRow);
  const dropped = entries.filter((e) => DROPPED.includes(e.status)).map(entryRow);

  const sections = [
    { id: "benchmarks", label: "Benchmarks", rows: benchRows, collapsedByDefault: false, pinned: true },
    { id: "picks", label: "Arm picks", rows: picks, collapsedByDefault: false },
    ...(watching.length ? [{ id: "watching", label: "Watching / shadow", rows: watching, collapsedByDefault: false }] : []),
    ...(dropped.length ? [{ id: "dropped", label: "Dropped", rows: dropped, collapsedByDefault: true }] : []),
  ];

  const all = sections.flatMap((s) => s.rows);
  const maxOf = (xs: (string | null)[]) => xs.filter((x): x is string => !!x).sort().pop() ?? null;
  const asOf = {
    quotes: maxOf(Object.values(opts.quotes).map((q) => q.asOf)),
    fundamentals: maxOf(all.map((r) => r._fundamentalsAsOf)),
    metrics: maxOf(all.map((r) => r._metricsAsOf)),
    fx: opts.fx?.asOf ?? null,
  };
  const cleaned = sections.map((s) => ({ ...s, rows: s.rows.map(({ _metricsAsOf, _fundamentalsAsOf, ...r }) => r) }));
  return { tf: opts.tf, sections: cleaned, asOf, fx: opts.fx, missingSymbols: Array.from(new Set(all.filter((r) => r.computing).map((r) => r.symbol))) };
}
