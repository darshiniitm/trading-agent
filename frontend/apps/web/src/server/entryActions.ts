import type Database from "better-sqlite3";

// The two per-user edits the detail panel offers. Both are scoped to the viewer's own watchlist row, so a follower
// removing a stock never touches the owner's list.
function ownEntry(raw: Database.Database, watchlistId: number, entryId: number, userId: number) {
  return raw.prepare(
    `SELECT e.entry_id, e.status FROM watchlist_entries e JOIN watchlists w ON w.watchlist_id = e.watchlist_id
     WHERE e.entry_id = ? AND e.watchlist_id = ? AND w.user_id = ?`
  ).get(entryId, watchlistId, userId) as { entry_id: number; status: string } | undefined;
}

export function setEntryNote(raw: Database.Database, args: { watchlistId: number; entryId: number; userId: number; note: string }) {
  if (!ownEntry(raw, args.watchlistId, args.entryId, args.userId)) return false;
  raw.prepare("UPDATE watchlist_entries SET user_note = ?, updated_at = ? WHERE entry_id = ?").run(args.note.slice(0, 2000) || null, new Date().toISOString(), args.entryId);
  return true;
}

export function removeEntry(raw: Database.Database, args: { watchlistId: number; entryId: number; userId: number }) {
  const row = ownEntry(raw, args.watchlistId, args.entryId, args.userId);
  if (!row) return false;
  const at = new Date().toISOString();
  raw.transaction(() => {
    raw.prepare("UPDATE watchlist_entries SET status = 'removed_by_user', updated_at = ? WHERE entry_id = ?").run(at, args.entryId);
    raw.prepare("INSERT INTO entry_events (entry_id, type, from_value, to_value, at) VALUES (?, 'status_changed', ?, 'removed_by_user', ?)").run(args.entryId, row.status, at);
  })();
  return true;
}
