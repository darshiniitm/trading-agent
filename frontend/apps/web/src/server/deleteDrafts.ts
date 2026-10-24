import type { Db } from "./db/pg";

/**
 * Permanently deletes the caller's own unconfirmed drafts (a confirmed draft is the record behind a numbered prompt and is
 * never touched). `ids` limits it to those drafts; omit it to delete every unconfirmed draft the user has.
 * Other users' drafts and unknown ids are skipped silently. Returns how many were deleted.
 */
export async function deleteDrafts(raw: Db, userId: number, ids?: number[]): Promise<number> {
  const mine = await raw.all<{ draft_id: number }>("SELECT draft_id FROM prompt_drafts WHERE user_id = ? AND status != 'confirmed' AND confirmed_prompt_id IS NULL", [userId]);
  const allowed = ids ? new Set(ids) : null;
  const doomed = mine.map((r) => r.draft_id).filter((id) => !allowed || allowed.has(id));
  await raw.tx(async (t) => {
    for (const id of doomed) {
      await t.run("DELETE FROM compilations WHERE draft_id = ?", [id]);
      await t.run("DELETE FROM prompt_drafts WHERE draft_id = ?", [id]);
    }
  });
  return doomed.length;
}
