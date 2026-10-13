import type Database from "better-sqlite3";

/** Another user's draft is indistinguishable from a missing one (404, never 403) so ids can't be probed. */
export function ownsDraft(raw: Database.Database, userId: number, draftId: number): boolean {
  const row = raw.prepare("SELECT user_id FROM prompt_drafts WHERE draft_id = ?").get(draftId) as { user_id: number } | undefined;
  return !!row && row.user_id === userId;
}
export function ownsPrompt(raw: Database.Database, userId: number, promptId: number): boolean {
  const row = raw.prepare("SELECT owner_user_id FROM prompts WHERE prompt_id = ?").get(promptId) as { owner_user_id: number } | undefined;
  return !!row && row.owner_user_id === userId;
}
/** Watchlist is mine, or its prompt is shared (read-only). */
export function canReadWatchlist(raw: Database.Database, userId: number, watchlistId: number): boolean {
  const row = raw.prepare("SELECT w.user_id, p.owner_user_id, p.visibility FROM watchlists w JOIN prompts p ON p.prompt_id = w.prompt_id WHERE w.watchlist_id = ?").get(watchlistId) as any;
  return !!row && (row.user_id === userId || row.owner_user_id === userId || row.visibility === "shared");
}
export function ownsWatchlist(raw: Database.Database, userId: number, watchlistId: number): boolean {
  const row = raw.prepare("SELECT user_id FROM watchlists WHERE watchlist_id = ?").get(watchlistId) as { user_id: number } | undefined;
  return !!row && row.user_id === userId;
}
