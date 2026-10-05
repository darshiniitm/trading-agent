import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { getDraft } from "@/server/drafts";
import { screen } from "@/server/engine/client";

function statusFor(membership: string): string {
  return membership === "full_match" ? "pending_selection" : "watching";
}

function remapKeysToCondNo(values: Record<string, unknown>, idToCondNo: Record<string, number>) {
  const out: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(values)) {
    const condNo = idToCondNo[id];
    if (condNo !== undefined) out[`C${condNo}`] = value;
  }
  return out;
}

function remapIdsToCondNo(ids: string[], idToCondNo: Record<string, number>): string[] {
  return ids.filter((id) => idToCondNo[id] !== undefined).map((id) => `C${idToCondNo[id]}`);
}

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

  const screenResult = await screen(draft.spec!, asOf, fetchFn);

  const idToCondNo: Record<string, number> = {};
  draft.spec!.conditions.forEach((cond, i) => {
    idToCondNo[cond.id] = i + 1;
  });

  const now = new Date().toISOString();
  const run = raw.transaction(() => {
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

    draft.spec!.conditions.forEach((cond, i) => {
      raw
        .prepare(
          `INSERT INTO prompt_conditions (prompt_id, cond_no, role, kind, name, params_json, op, value_json, value_origin)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'user_answer')`
        )
        .run(promptId, i + 1, cond.role, cond.kind, cond.name, JSON.stringify(cond.params ?? {}), cond.op, JSON.stringify(cond.value ?? null));
    });

    const watchlistInfo = raw
      .prepare(`INSERT INTO watchlists (user_id, prompt_id, name, created_at) VALUES (?, ?, ?, ?)`)
      .run(draft.userId, promptId, draft.title ?? `Prompt ${promptId}`, now);
    const watchlistId = Number(watchlistInfo.lastInsertRowid);

    const runInfo = raw
      .prepare(
        `INSERT INTO runs (prompt_id, as_of, kind, status, applied_steps_json, funnel_json, finished_at)
         VALUES (?, ?, 'catch_up', 'done', ?, ?, ?)`
      )
      .run(promptId, asOf, JSON.stringify(screenResult.applied_steps), JSON.stringify(screenResult.funnel), now);
    const runId = Number(runInfo.lastInsertRowid);

    for (const candidate of screenResult.candidates) {
      raw
        .prepare(`INSERT OR IGNORE INTO symbols (symbol, active) VALUES (?, 1)`)
        .run(candidate.ticker);

      const entryStatus = statusFor(candidate.membership);
      const condJson = remapKeysToCondNo(candidate.values, idToCondNo);
      const failedCondsJson = remapIdsToCondNo(candidate.failed_ids, idToCondNo);

      raw
        .prepare(
          `INSERT INTO run_results
             (run_id, symbol, membership, in_forward_record, failed_conds_json, cond_json, metrics_json,
              ep, sl, ref_price, confidence, entry_status)
           VALUES (?, ?, ?, 0, ?, ?, NULL, ?, ?, ?, NULL, ?)`
        )
        .run(
          runId, candidate.ticker, candidate.membership, JSON.stringify(failedCondsJson), JSON.stringify(condJson),
          candidate.membership === "full_match" ? candidate.ep : null,
          candidate.membership === "full_match" ? candidate.sl : null,
          candidate.membership === "full_match" ? null : candidate.ep,
          entryStatus
        );

      raw
        .prepare(
          `INSERT INTO watchlist_entries
             (watchlist_id, symbol, first_run_id, last_run_id, membership, status, ref_price, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          watchlistId, candidate.ticker, runId, runId, candidate.membership, entryStatus,
          candidate.membership === "full_match" ? null : candidate.ep, now, now
        );
    }

    raw
      .prepare(`UPDATE prompt_drafts SET status = 'confirmed', confirmed_prompt_id = ?, updated_at = ? WHERE draft_id = ?`)
      .run(promptId, now, draftId);

    return { promptId, watchlistId };
  });

  return run();
}
