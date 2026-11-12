import type { Db } from "../db/pg";

/** Another user's draft is indistinguishable from a missing one (404, never 403) so ids can't be probed. */
export async function ownsDraft(raw: Db, userId: number, draftId: number): Promise<boolean> {
  const row = await raw.get<{ user_id: number }>("SELECT user_id FROM prompt_drafts WHERE draft_id = ?", [draftId]);
  return !!row && row.user_id === userId;
}
export async function ownsPrompt(raw: Db, userId: number, promptId: number): Promise<boolean> {
  const row = await raw.get<{ owner_user_id: number }>("SELECT owner_user_id FROM prompts WHERE prompt_id = ?", [promptId]);
  return !!row && row.owner_user_id === userId;
}
/** Watchlist is mine, or its prompt is shared (read-only). */
export async function canReadWatchlist(raw: Db, userId: number, watchlistId: number): Promise<boolean> {
  const row = await raw.get("SELECT w.user_id, p.owner_user_id, p.visibility FROM watchlists w JOIN prompts p ON p.prompt_id = w.prompt_id WHERE w.watchlist_id = ?", [watchlistId]);
  return !!row && (row.user_id === userId || row.owner_user_id === userId || row.visibility === "shared");
}
export async function ownsWatchlist(raw: Db, userId: number, watchlistId: number): Promise<boolean> {
  const row = await raw.get<{ user_id: number }>("SELECT user_id FROM watchlists WHERE watchlist_id = ?", [watchlistId]);
  return !!row && row.user_id === userId;
}
