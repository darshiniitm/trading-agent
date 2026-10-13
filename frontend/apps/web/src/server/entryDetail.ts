import type Database from "better-sqlite3";

export function getEntryDetail(raw: Database.Database, entryId: number) {
  const entry = raw.prepare("SELECT * FROM watchlist_entries WHERE entry_id = ?").get(entryId) as any;
  if (!entry) return null;

  const events = (raw.prepare("SELECT type, from_value, to_value, at FROM entry_events WHERE entry_id = ? ORDER BY at ASC").all(entryId) as any[]).map((e) => ({
    type: e.type, fromValue: e.from_value, toValue: e.to_value, at: e.at,
  }));

  return {
    entryId: entry.entry_id, symbol: entry.symbol, membership: entry.membership, status: entry.status,
    entryPrice: entry.entry_price, stop: entry.stop, refPrice: entry.ref_price, userNote: entry.user_note,
    events,
  };
}
