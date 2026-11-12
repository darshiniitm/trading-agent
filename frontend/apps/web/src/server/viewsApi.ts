import type { Db } from "@/server/db/pg";
import { getQuotes, type Quote } from "@/server/quotes";
import { buildWatchlistViews, type Fx } from "@/server/views";
import { computeMetrics, getViewPrefs } from "@/server/viewData";

const FX_SYMBOL = "USDINR=X";

async function safeQuotes(symbols: string[]): Promise<Record<string, Quote>> {
  try { return await getQuotes(symbols); } catch { return {}; }
}

// USDINR=X quotes INR per USD; INR -> USD therefore divides by it (the plan's "multiply" would invert the rate).
export function fxFrom(quotes: Record<string, Quote>): Fx | null {
  const q = quotes[FX_SYMBOL];
  if (!q || q.error || !q.price || q.price <= 0) return null;
  return { inrPerUsd: q.price, usdPerInr: 1 / q.price, asOf: q.asOf };
}

// Symbols whose background compute is already running, so a page polling while metrics are pending doesn't pile up engine calls.
const inflight = new Set<string>();
function computeInBackground(raw: Db, symbols: string[], tf: "1D" | "1W") {
  // A serverless function is frozen once it has responded, so fire-and-forget work would stall half-done; there the
  // weekly job (and the refresh button) fill in missing metrics instead.
  if (process.env.NETLIFY) return;
  const fresh = symbols.filter((s) => !inflight.has(`${tf}:${s}`));
  if (!fresh.length) return;
  fresh.forEach((s) => inflight.add(`${tf}:${s}`));
  void computeMetrics(raw, fresh, { tf }).catch(() => {}).finally(() => fresh.forEach((s) => inflight.delete(`${tf}:${s}`)));
}

/** One call returns every view group, so switching views never refetches. Missing metrics are computed in the background. */
export async function loadWatchlistViews(raw: Db, watchlistId: number, userId: number, tf: "1D" | "1W", opts: { refresh?: boolean } = {}) {
  const probe = await buildWatchlistViews(raw, watchlistId, userId, { tf, quotes: {}, fx: null });
  const symbols = probe.sections.flatMap((s) => s.rows.map((r) => r.symbol));
  if (opts.refresh) {
    try { await computeMetrics(raw, Array.from(new Set(symbols)), { tf, force: true }); } catch { /* engine down: serve what is stored */ }
  }
  const quotes = await safeQuotes([...symbols, FX_SYMBOL]);
  const views = await buildWatchlistViews(raw, watchlistId, userId, { tf, quotes, fx: fxFrom(quotes) });
  if (views.missingSymbols.length) computeInBackground(raw, views.missingSymbols, tf);
  return { ...views, prefs: await getViewPrefs(raw, userId, watchlistId) };
}
