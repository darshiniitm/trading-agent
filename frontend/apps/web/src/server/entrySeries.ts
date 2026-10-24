import type { Db } from "./db/pg";
import { getSeries, type SeriesParams } from "@/server/engine/client";

// The detail chart is drawn with the prompt's OWN indicator settings, taken unchanged from its stored conditions.
export async function seriesParamsFor(raw: Db, promptId: number): Promise<SeriesParams> {
  const rows = await raw.all<{ name: string; params_json: string | null }>("SELECT name, params_json FROM prompt_conditions WHERE prompt_id = ? ORDER BY cond_no", [promptId]);
  const out: SeriesParams = {};
  for (const r of rows) {
    const p = r.params_json ? JSON.parse(r.params_json) : {};
    if (r.name === "vstop" && out.vstopLength === undefined && typeof p.length === "number") {
      out.vstopLength = p.length;
      if (typeof p.mult === "number") out.vstopMult = p.mult;
      if (typeof p.source === "string") out.vstopSource = p.source;
    }
    if (r.name === "rsi" && out.rsiLength === undefined && typeof p.length === "number") out.rsiLength = p.length;
  }
  return out;
}

export async function getEntrySeries(raw: Db, watchlistId: number, entryId: number, fetchFn: typeof fetch = fetch) {
  const row = await raw.get<{ symbol: string; prompt_id: number }>(
    `SELECT e.symbol, w.prompt_id FROM watchlist_entries e JOIN watchlists w ON w.watchlist_id = e.watchlist_id WHERE e.entry_id = ? AND e.watchlist_id = ?`,
    [entryId, watchlistId]);
  if (!row) return null;
  return getSeries(row.symbol, await seriesParamsFor(raw, row.prompt_id), fetchFn);
}
