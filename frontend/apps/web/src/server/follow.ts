import type Database from "better-sqlite3";
import { getAccessiblePrompt, ForbiddenError } from "./access";

function seedWatchlist(raw: Database.Database, watchlistId: number, promptId: number) {
  const run = raw.prepare("SELECT run_id FROM runs WHERE prompt_id = ? ORDER BY run_id DESC LIMIT 1").get(promptId) as { run_id: number } | undefined;
  if (!run) return;
  const rows = raw.prepare("SELECT * FROM run_results WHERE run_id = ?").all(run.run_id) as any[];
  const now = new Date().toISOString();
  const insertSymbol = raw.prepare("INSERT OR IGNORE INTO symbols (symbol, active) VALUES (?, 1)");
  const insert = raw.prepare("INSERT OR IGNORE INTO watchlist_entries (watchlist_id, symbol, first_run_id, last_run_id, membership, status, entry_price, ref_price, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const row of rows) {
    insertSymbol.run(row.symbol);
    const status = row.membership === "full_match" ? (row.entry_status ?? "pending_selection") : "watching";
    insert.run(watchlistId, row.symbol, run.run_id, run.run_id, row.membership, status, row.entry_price ?? null, row.ref_price ?? null, now, now);
  }
}

export function followPrompt(raw: Database.Database, { promptId, userId }: { promptId: number; userId: number }) {
  const prompt = getAccessiblePrompt(raw, promptId, userId);
  if (prompt.owner_user_id === userId) throw new ForbiddenError("owners already have a watchlist");
  const existing = raw.prepare("SELECT watchlist_id FROM watchlists WHERE user_id = ? AND prompt_id = ?").get(userId, promptId) as { watchlist_id: number } | undefined;
  const now = new Date().toISOString();
  let watchlistId: number;
  raw.transaction(() => {
    if (existing) {
      watchlistId = existing.watchlist_id;
      raw.prepare("UPDATE watchlists SET archived_at = NULL WHERE watchlist_id = ?").run(watchlistId);
    } else {
      const result = raw.prepare("INSERT INTO watchlists (user_id, prompt_id, name, created_at) VALUES (?, ?, ?, ?)").run(userId, promptId, prompt.title, now);
      watchlistId = Number(result.lastInsertRowid);
    }
    seedWatchlist(raw, watchlistId!, promptId);
  })();
  return { watchlistId: watchlistId! };
}

export function unfollowPrompt(raw: Database.Database, { promptId, userId }: { promptId: number; userId: number }) {
  const prompt = getAccessiblePrompt(raw, promptId, userId);
  if (prompt.owner_user_id === userId) throw new ForbiddenError("owners cannot unfollow their own prompt");
  raw.prepare("UPDATE watchlists SET archived_at = ? WHERE user_id = ? AND prompt_id = ?").run(new Date().toISOString(), userId, promptId);
}
