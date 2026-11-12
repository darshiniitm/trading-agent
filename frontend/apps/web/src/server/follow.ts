import type { Db } from "./db/pg";
import { getAccessiblePrompt, ForbiddenError } from "./access";

async function seedWatchlist(raw: Db, watchlistId: number, promptId: number) {
  const run = await raw.get<{ run_id: number }>("SELECT run_id FROM runs WHERE prompt_id = ? ORDER BY run_id DESC LIMIT 1", [promptId]);
  if (!run) return;
  const rows = await raw.all("SELECT * FROM run_results WHERE run_id = ?", [run.run_id]);
  const now = new Date().toISOString();
  for (const row of rows) {
    await raw.run("INSERT INTO symbols (symbol, active) VALUES (?, 1) ON CONFLICT DO NOTHING", [row.symbol]);
    const status = row.membership === "full_match" ? (row.entry_status ?? "pending_selection") : "watching";
    await raw.run("INSERT INTO watchlist_entries (watchlist_id, symbol, first_run_id, last_run_id, membership, status, entry_price, ref_price, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
      [watchlistId, row.symbol, run.run_id, run.run_id, row.membership, status, row.entry_price ?? null, row.ref_price ?? null, now, now]);
  }
}

export async function followPrompt(raw: Db, { promptId, userId }: { promptId: number; userId: number }) {
  const prompt = await getAccessiblePrompt(raw, promptId, userId);
  if (prompt.owner_user_id === userId) throw new ForbiddenError("owners already have a watchlist");
  const existing = await raw.get<{ watchlist_id: number }>("SELECT watchlist_id FROM watchlists WHERE user_id = ? AND prompt_id = ?", [userId, promptId]);
  const now = new Date().toISOString();
  const watchlistId = await raw.tx(async (t) => {
    let id: number;
    if (existing) {
      id = existing.watchlist_id;
      await t.run("UPDATE watchlists SET archived_at = NULL WHERE watchlist_id = ?", [id]);
    } else {
      id = (await t.get<{ watchlist_id: number }>("INSERT INTO watchlists (user_id, prompt_id, name, created_at) VALUES (?, ?, ?, ?) RETURNING watchlist_id", [userId, promptId, prompt.title, now]))!.watchlist_id;
    }
    await seedWatchlist(t, id, promptId);
    return id;
  });
  return { watchlistId };
}

export async function unfollowPrompt(raw: Db, { promptId, userId }: { promptId: number; userId: number }) {
  const prompt = await getAccessiblePrompt(raw, promptId, userId);
  if (prompt.owner_user_id === userId) throw new ForbiddenError("owners cannot unfollow their own prompt");
  await raw.run("UPDATE watchlists SET archived_at = ? WHERE user_id = ? AND prompt_id = ?", [new Date().toISOString(), userId, promptId]);
}
