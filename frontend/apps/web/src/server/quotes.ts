import { ENGINE_BASE_URL, EngineError } from "@/server/engine/client";

type Quote = { price: number | null; asOf: string | null; error: string | null };

const CACHE_MS = 60_000;
let cache = new Map<string, { quote: Quote; fetchedAtMs: number }>();

export function _resetQuoteCacheForTests() {
  cache = new Map();
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
    const res = await fetchFn(`${ENGINE_BASE_URL}/quotes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbols: toFetch }),
    });
    const body = await res.json();
    if (!res.ok) throw new EngineError(res.status, body);
    for (const symbol of toFetch) {
      const raw = body[symbol] ?? { price: null, as_of: null, error: "not returned by engine" };
      const quote: Quote = { price: raw.price, asOf: raw.as_of, error: raw.error };
      cache.set(symbol, { quote, fetchedAtMs: nowMs });
      result[symbol] = quote;
    }
  }

  return result;
}
