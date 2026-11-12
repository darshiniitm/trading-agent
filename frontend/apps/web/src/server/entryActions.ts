import type { Db } from "./db/pg";

// The two per-user edits the detail panel offers. Both are scoped to the viewer's own watchlist row, so a follower
// removing a stock never touches the owner's list.
function ownEntry(raw: Db, watchlistId: number, entryId: number, userId: number) {
  return raw.get<{ entry_id: number; status: string }>(
    `SELECT e.entry_id, e.status FROM watchlist_entries e JOIN watchlists w ON w.watchlist_id = e.watchlist_id
     WHERE e.entry_id = ? AND e.watchlist_id = ? AND w.user_id = ?`,
    [entryId, watchlistId, userId]);
}

export async function setEntryNote(raw: Db, args: { watchlistId: number; entryId: number; userId: number; note: string }) {
  if (!(await ownEntry(raw, args.watchlistId, args.entryId, args.userId))) return false;
  await raw.run("UPDATE watchlist_entries SET user_note = ?, updated_at = ? WHERE entry_id = ?", [args.note.slice(0, 2000) || null, new Date().toISOString(), args.entryId]);
  return true;
}

export async function removeEntry(raw: Db, args: { watchlistId: number; entryId: number; userId: number }) {
  const row = await ownEntry(raw, args.watchlistId, args.entryId, args.userId);
  if (!row) return false;
  const at = new Date().toISOString();
  await raw.tx(async (t) => {
    await t.run("UPDATE watchlist_entries SET status = 'removed_by_user', updated_at = ? WHERE entry_id = ?", [at, args.entryId]);
    await t.run("INSERT INTO entry_events (entry_id, type, from_value, to_value, at) VALUES (?, 'status_changed', ?, 'removed_by_user', ?)", [args.entryId, row.status, at]);
  });
  return true;
}
