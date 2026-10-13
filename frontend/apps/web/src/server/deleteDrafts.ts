import type Database from "better-sqlite3";

/**
 * Permanently deletes the caller's own unconfirmed drafts (a confirmed draft is the record behind a numbered prompt and is
 * never touched). `ids` limits it to those drafts; omit it to delete every unconfirmed draft the user has.
 * Other users' drafts and unknown ids are skipped silently. Returns how many were deleted.
 */
export function deleteDrafts(raw: Database.Database, userId: number, ids?: number[]): number {
  const mine = raw.prepare("SELECT draft_id FROM prompt_drafts WHERE user_id = ? AND status != 'confirmed' AND confirmed_prompt_id IS NULL").all(userId) as { draft_id: number }[];
  const allowed = ids ? new Set(ids) : null;
  const doomed = mine.map((r) => r.draft_id).filter((id) => !allowed || allowed.has(id));
  const dropCompilations = raw.prepare("DELETE FROM compilations WHERE draft_id = ?");
  const dropDraft = raw.prepare("DELETE FROM prompt_drafts WHERE draft_id = ?");
  raw.transaction(() => { for (const id of doomed) { dropCompilations.run(id); dropDraft.run(id); } })();
  return doomed.length;
}
