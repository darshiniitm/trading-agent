import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { getDraft } from "@/server/drafts";
import { runWeeklyScreen } from "@/server/weeklyScreen";

export async function confirmDraft(
  raw: Database.Database,
  draftId: number,
  asOf: string,
  fetchFn?: typeof fetch
): Promise<{ promptId: number; watchlistId: number }> {
  const draft = getDraft(raw, draftId);
  if (!draft) throw new Error(`draft ${draftId} not found`);
  if (draft.status === "confirmed") throw new Error("draft already confirmed");
  if (draft.status === "abandoned") throw new Error("draft is abandoned");

  const problems: string[] = [];
  if (!draft.spec) problems.push("no spec");
  if (!draft.structure) problems.push("no structure");
  if (!draft.hypothesis) problems.push("no hypothesis");
  if (!draft.killCriterion) problems.push("no kill criterion");
  if (problems.length > 0) throw new Error(`confirm blocked: ${problems.join(", ")}`);

  const specJson = JSON.stringify(draft.spec);
  const specHash = createHash("sha256").update(specJson).digest("hex");

  const existingPrompt = raw
    .prepare("SELECT prompt_id FROM prompts WHERE owner_user_id = ? AND spec_hash = ? AND status = 'confirmed'")
    .get(draft.userId, specHash) as { prompt_id: number } | undefined;
  if (existingPrompt) {
    throw new Error(
      `you already have a confirmed prompt with these exact conditions (Prompt ${existingPrompt.prompt_id})`
    );
  }

  const now = new Date().toISOString();
  const createPromptAndWatchlist = raw.transaction(() => {
    let promptInfo;
    try {
      promptInfo = raw
        .prepare(
          `INSERT INTO prompts
             (owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash,
              status, version, hypothesis, kill_criterion, confirmed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', 1, ?, ?, ?)`
        )
        .run(
          draft.userId, draftId, draft.title ?? `Prompt from draft ${draftId}`, draft.promptText,
          draft.structure, specJson, specHash, draft.hypothesis, draft.killCriterion, now
        );
    } catch (err: any) {
      // Closes the gap between the pre-check above and this transaction: two
      // concurrent confirms of the same (user, spec) can both pass that
      // SELECT before either writes. The unique index is still the real
      // guard against a double-write; this only re-translates its error.
      if (String(err.message).includes("UNIQUE constraint failed: prompts.owner_user_id, prompts.spec_hash")) {
        const winner = raw
          .prepare("SELECT prompt_id FROM prompts WHERE owner_user_id = ? AND spec_hash = ? AND status = 'confirmed'")
          .get(draft.userId, specHash) as { prompt_id: number };
        throw new Error(`you already have a confirmed prompt with these exact conditions (Prompt ${winner.prompt_id})`);
      }
      throw err;
    }
    const promptId = Number(promptInfo.lastInsertRowid);

    // Prepared once and reused below, never inside a per-candidate/per-condition
    // loop: better-sqlite3 Statement objects are native (N-API) handles finalized
    // by GC, and preparing a fresh one on every iteration of a large screen
    // (hundreds of candidates is the normal case, not an edge case) creates
    // hundreds of short-lived native objects in one synchronous transaction.
    // That reproducibly crashed the whole Next.js dev server (native assertion
    // in node::RemoveEnvironmentCleanupHook, inside better-sqlite3's Statement
    // destructor) under a real screen result — see the end-to-end smoke test.
    const insertCondition = raw.prepare(
      `INSERT INTO prompt_conditions (prompt_id, cond_no, role, kind, name, params_json, op, value_json, value_origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'user_answer')`
    );
    draft.spec!.conditions.forEach((cond, i) => {
      insertCondition.run(promptId, i + 1, cond.role, cond.kind, cond.name, JSON.stringify(cond.params ?? {}), cond.op, JSON.stringify(cond.value ?? null));
    });

    const watchlistInfo = raw
      .prepare(`INSERT INTO watchlists (user_id, prompt_id, name, created_at) VALUES (?, ?, ?, ?)`)
      .run(draft.userId, promptId, draft.title ?? `Prompt ${promptId}`, now);
    const watchlistId = Number(watchlistInfo.lastInsertRowid);

    raw
      .prepare(`UPDATE prompt_drafts SET status = 'confirmed', confirmed_prompt_id = ?, updated_at = ? WHERE draft_id = ?`)
      .run(promptId, now, draftId);

    return { promptId, watchlistId };
  });

  const { promptId, watchlistId } = createPromptAndWatchlist();

  // runWeeklyScreen does its own HTTP round-trip, so it can't live inside the
  // synchronous better-sqlite3 transaction above. A 422 from the engine must
  // still surface as if nothing had been written, per the confirm.test.ts
  // regression ("propagates a 422... without writing anything") — so on
  // failure here, undo the prompt/watchlist/conditions/draft-status change
  // rather than leaving a prompt with no run at all.
  try {
    await runWeeklyScreen(raw, { promptId, asOf, kind: "catch_up" }, fetchFn);
  } catch (err) {
    raw.transaction(() => {
      // prompt_drafts.confirmed_prompt_id references prompts(prompt_id), so it
      // must be cleared before the prompt row is deleted — deleting prompts
      // first trips a FOREIGN KEY constraint (prompt_drafts still pointing at
      // the row being removed).
      raw.prepare(`UPDATE prompt_drafts SET status = 'open', confirmed_prompt_id = NULL, updated_at = ? WHERE draft_id = ?`).run(new Date().toISOString(), draftId);
      raw.prepare("DELETE FROM watchlists WHERE watchlist_id = ?").run(watchlistId);
      raw.prepare("DELETE FROM prompt_conditions WHERE prompt_id = ?").run(promptId);
      raw.prepare("DELETE FROM prompts WHERE prompt_id = ?").run(promptId);
    })();
    throw err;
  }

  return { promptId, watchlistId };
}
