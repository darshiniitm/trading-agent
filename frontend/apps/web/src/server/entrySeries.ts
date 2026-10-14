import type Database from "better-sqlite3";
import { getSeries, type SeriesParams } from "@/server/engine/client";

// The detail chart is drawn with the prompt's OWN indicator settings, taken unchanged from its stored conditions.
export function seriesParamsFor(raw: Database.Database, promptId: number): SeriesParams {
  const rows = raw.prepare("SELECT name, params_json FROM prompt_conditions WHERE prompt_id = ? ORDER BY cond_no").all(promptId) as { name: string; params_json: string | null }[];
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

export async function getEntrySeries(raw: Database.Database, watchlistId: number, entryId: number, fetchFn: typeof fetch = fetch) {
  const row = raw.prepare(
    `SELECT e.symbol, w.prompt_id FROM watchlist_entries e JOIN watchlists w ON w.watchlist_id = e.watchlist_id WHERE e.entry_id = ? AND e.watchlist_id = ?`
  ).get(entryId, watchlistId) as { symbol: string; prompt_id: number } | undefined;
  if (!row) return null;
  return getSeries(row.symbol, seriesParamsFor(raw, row.prompt_id), fetchFn);
}
