import { getSeries } from "@/server/engine/client";

// 12-week sparkline data for every row of a watchlist: the last N weekly closes per symbol. Cached per symbol
// per last bar date, so a repeat request makes no engine call; at most 4 engine calls run at once.
const cache = new Map<string, number[]>();
export function _resetClosesCacheForTests() { cache.clear(); }

export async function getRecentCloses(symbols: string[], weeks = 12, fetchFn: typeof fetch = fetch, lastBarDate = "") {
  const unique = Array.from(new Set(symbols));
  const out: Record<string, number[]> = {};
  const queue = unique.slice();
  async function worker() {
    for (let s = queue.shift(); s !== undefined; s = queue.shift()) {
      const key = `${lastBarDate}|${weeks}|${s}`;
      const hit = cache.get(key);
      if (hit) { out[s] = hit; continue; }
      try {
        const { bars } = await getSeries(s, {}, fetchFn);
        const closes = bars.map((b) => b.close).filter((c): c is number => typeof c === "number").slice(-weeks);
        out[s] = closes;
        cache.set(key, closes);
      } catch { out[s] = []; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, unique.length) }, worker));
  return out;
}
