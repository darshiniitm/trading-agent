import type { Db } from "./db/pg";

export async function getEntryDetail(raw: Db, entryId: number) {
  const entry = await raw.get("SELECT * FROM watchlist_entries WHERE entry_id = ?", [entryId]);
  if (!entry) return null;

  const events = (await raw.all("SELECT type, from_value, to_value, at FROM entry_events WHERE entry_id = ? ORDER BY at ASC, event_id ASC", [entryId])).map((e) => ({
    type: e.type, fromValue: e.from_value, toValue: e.to_value, at: e.at,
  }));

  return {
    entryId: entry.entry_id, symbol: entry.symbol, membership: entry.membership, status: entry.status,
    entryPrice: entry.entry_price, stop: entry.stop, refPrice: entry.ref_price, userNote: entry.user_note,
    events,
  };
}
