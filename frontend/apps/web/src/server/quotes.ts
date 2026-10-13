import { postQuotes } from "@/server/engine/client";

// chgPct is the day change vs the previous close; omitted when the engine sent no prev_close.
export type Quote = { price: number | null; asOf: string | null; error: string | null; chgPct?: number };

const CACHE_MS = 60_000;
let cache = new Map<string, { quote: Quote; fetchedAtMs: number }>();

export function _resetQuoteCacheForTests() {
  cache = new Map();
}

function toQuote(raw: { price: number; source: string; source_ts: string; prev_close?: number } | { error: string }): Quote {
  if ("error" in raw) return { price: null, asOf: null, error: raw.error };
  const quote: Quote = { price: raw.price, asOf: raw.source_ts, error: null };
  if (typeof raw.prev_close === "number" && raw.prev_close > 0) quote.chgPct = ((raw.price - raw.prev_close) / raw.prev_close) * 100;
  return quote;
}

export async function getQuotes(
  symbols: string[],
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now
): Promise<Record<string, Quote>> {
  const unique = Array.from(new Set(symbols));
  const nowMs = now();
  const result: Record<string, Quote> = {};
  const toFetch: string[] = [];

  for (const symbol of unique) {
    const cached = cache.get(symbol);
    if (cached && nowMs - cached.fetchedAtMs < CACHE_MS) {
      result[symbol] = cached.quote;
    } else {
      toFetch.push(symbol);
    }
  }

  if (toFetch.length > 0) {
    const body = await postQuotes(toFetch, fetchFn);
    for (const symbol of toFetch) {
      const raw = body[symbol] ?? { error: "not returned by engine" };
      const quote = toQuote(raw);
      // Never cache a failure — a transient fetch error (timeout, rate limit)
      // shouldn't make "Refresh prices" a silent no-op for the next 60s.
      if (quote.error === null) cache.set(symbol, { quote, fetchedAtMs: nowMs });
      result[symbol] = quote;
    }
  }

  return result;
}
