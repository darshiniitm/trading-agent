import type { Db } from "@/server/db/pg";
import { createHash } from "node:crypto";
import { getDraft } from "@/server/drafts";
import { runWeeklyScreen } from "@/server/weeklyScreen";
import { registerArm, retireArm } from "@/server/engine/client";
import { runSelectEntry } from "@/server/selectEntry";
import { programConfirmProblems } from "@/server/compiler/v5/answer";
import { tracedLeafPaths } from "@/server/compiler/v5/verify";
import { structureOf } from "@/server/programOf";
import { resolveProgram } from "@/server/compiler/v5/resolve";
import { resolvedJson } from "@/server/compiler/v5/slots";
import { saveAccepted } from "@/server/learning";
import { getUserDefaults } from "@/server/userDefaults";
import { tool } from "@/server/telemetry";
import { inPromptRun } from "@/server/telemetry/run";

type Confirmed = { promptId: number; watchlistId: number; selectionWarning: string | null };

// observability: the whole confirm is the last stage of the draft's run; `prompt.run` is emitted when it finishes
export async function confirmDraft(raw: Db, draftId: number, asOf: string, fetchFn?: typeof fetch): Promise<Confirmed> {
  const d = await getDraft(raw, draftId);
  return inPromptRun({
    draftId, stage: "confirm",
    lookup: () => ({ userId: d?.userId, createdAt: d?.createdAt }),
    summarize: (r: Confirmed) => ({ promptId: r.promptId, outcome: r.selectionWarning ? "confirmed_with_warning" : "confirmed" }),
  }, () => confirmDraftInner(raw, draftId, asOf, fetchFn));
}

async function confirmDraftInner(
  raw: Db,
  draftId: number,
  asOf: string,
  fetchFn?: typeof fetch
): Promise<Confirmed> {
  const draft = await getDraft(raw, draftId);
  if (!draft) throw new Error(`draft ${draftId} not found`);
  if (draft.status === "confirmed") throw new Error("draft already confirmed");
  if (draft.status === "abandoned") throw new Error("draft is abandoned");

  // Nothing the interpreter had to assume blocks this (docs/prompt-interpreter-spec.md §2); hypothesis and
  // kill criterion are optional add-ons. The only block is a prompt that produced no rule at all.
  const defaults = await getUserDefaults(raw, draft.userId);
  const problems: string[] = [];
  if (!draft.program) problems.push("no interpreted program (use Interpret my prompt first)");
  else problems.push(...programConfirmProblems(resolveProgram(draft.program, defaults)));
  if (problems.length > 0) throw new Error(`confirm blocked: ${problems.join(", ")}`);

  const program = resolveProgram(draft.program!, defaults);
  const resolved = JSON.stringify(resolvedJson(program, defaults));
  const structure = structureOf(program);
  // The program as stored is what the engine screens. Its identity (for "you already have this prompt") is
  // the semantics only — universe, sets, conditions, actions — not the wording, spans or answer log.
  const specJson = JSON.stringify(program);
  const semantic = JSON.stringify({
    universe: program.universe, sets: program.sets, actions: program.actions,
    conditions: program.conditions.map(({ phrase: _phrase, ...c }) => c),
  });
  const specHash = createHash("sha256").update(semantic).digest("hex");

  // Excludes the draft's own parent (if any) from the duplicate-spec check:
  // an unedited version bump reuses the parent's exact spec_hash on purpose,
  // and that is not "you already have a confirmed prompt with these exact
  // conditions" — it is the new version superseding that very prompt.
  const existingPrompt = await raw.get<{ prompt_id: number }>(
    "SELECT prompt_id FROM prompts WHERE owner_user_id = ? AND spec_hash = ? AND status = 'confirmed' AND prompt_id IS DISTINCT FROM CAST(? AS bigint)",
    [draft.userId, specHash, draft.parentPromptId ?? null]);
  if (existingPrompt) {
    throw new Error(
      `you already have a confirmed prompt with these exact conditions (Prompt ${existingPrompt.prompt_id})`
    );
  }

  const now = new Date().toISOString();
  const createPromptAndWatchlist = () => raw.tx(async (t) => {
    const parent: { prompt_id: number; version: number; status: string } | null = draft.parentPromptId
      ? ((await t.get<{ prompt_id: number; version: number; status: string }>("SELECT prompt_id, version, status FROM prompts WHERE prompt_id = ?", [draft.parentPromptId])) ?? null)
      : null;
    if (draft.parentPromptId && !parent) throw new Error(`parent prompt ${draft.parentPromptId} not found`);
    if (parent && parent.status !== "confirmed") throw new Error(`parent prompt ${parent.prompt_id} is already ${parent.status}`);

    // Flip the parent out of 'confirmed' before inserting the new version,
    // in the same transaction: ux_prompts_owner_spec is a UNIQUE index on
    // (owner_user_id, spec_hash) WHERE status = 'confirmed', and an unedited
    // version bump reuses the parent's exact spec_hash, so both rows cannot
    // hold status='confirmed' at once. If runWeeklyScreen fails below, the
    // outer rollback reverts this alongside everything else it undoes.
    if (parent) {
      await t.run("UPDATE prompts SET status = 'superseded', closed_at = ? WHERE prompt_id = ?", [now, parent.prompt_id]);
    }

    let promptId: number;
    try {
      // Own savepoint: a unique violation aborts a Postgres transaction, and the handler below must still be
      // able to read the winning row before rethrowing.
      promptId = await t.tx(async (sp) => (await sp.get<{ prompt_id: number }>(
        `INSERT INTO prompts
           (owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash,
            status, parent_prompt_id, version, hypothesis, kill_criterion, copied_from_prompt_id, confirmed_at, resolved_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?) RETURNING prompt_id`,
        [draft.userId, draftId, draft.title ?? `Prompt from draft ${draftId}`, draft.promptText,
          structure, specJson, specHash, parent ? parent.prompt_id : null, parent ? parent.version + 1 : 1,
          draft.hypothesis ?? "", draft.killCriterion ?? "", draft.copiedFromPromptId, now, resolved]))!.prompt_id);
    } catch (err: any) {
      // Closes the gap between the pre-check above and this transaction: two
      // concurrent confirms of the same (user, spec) can both pass that
      // SELECT before either writes. The unique index is still the real
      // guard against a double-write; this only re-translates its error.
      if (err?.code === "23505" && /ux_prompts_owner_spec/.test(`${err.constraint ?? ""} ${err.message}`)) {
        const winner = await t.get<{ prompt_id: number }>("SELECT prompt_id FROM prompts WHERE owner_user_id = ? AND spec_hash = ? AND status = 'confirmed'", [draft.userId, specHash]);
        throw new Error(`you already have a confirmed prompt with these exact conditions (Prompt ${winner!.prompt_id})`);
      }
      throw err;
    }

    const sourcePhrases = program.source_phrases;
    const knownPhrasePaths = new Set(sourcePhrases.map((sp) => sp.path));
    const knownAnswerPaths = new Set(program.answers.map((a) => a.path));
    const leaves = tracedLeafPaths(program).map((l) => l.path);

    // A condition is 'prompt'-origin only if every one of its traceable leaves (each param value and value,
    // number or text) has a source phrase and none was answered by the user; anything else — an answered
    // leaf, or the app's own liquidity floor — makes the whole row 'user_answer'.
    for (const [i, cond] of program.conditions.entries()) {
      const mine = leaves.filter((p) => p.startsWith(`conditions.${cond.id}.`));
      const allFromPrompt = mine.length > 0 && mine.every((p) => knownPhrasePaths.has(p)) && !mine.some((p) => knownAnswerPaths.has(p));
      const valueOrigin: "prompt" | "user_answer" = allFromPrompt ? "prompt" : "user_answer";
      const sourcePhrase = allFromPrompt ? sourcePhrases.filter((sp) => mine.includes(sp.path)).map((sp) => sp.phrase).join(" / ") || null : null;
      const lhs: any = cond.lhs;
      const isEvent = ["flip", "cross_above", "cross_below", "cross_any"].includes(cond.op ?? "");
      await t.run(
        `INSERT INTO prompt_conditions (prompt_id, cond_no, role, kind, name, params_json, op, value_json, value_origin, source_phrase)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [promptId, i + 1, isEvent ? "event" : "filter", "field" in lhs ? "field" : "indicator", "field" in lhs ? lhs.field : lhs.ind,
          JSON.stringify(lhs.params ?? {}), cond.op, JSON.stringify(cond.value ?? null), valueOrigin, sourcePhrase]
      );
    }

    const watchlistId = (await t.get<{ watchlist_id: number }>(
      `INSERT INTO watchlists (user_id, prompt_id, name, created_at) VALUES (?, ?, ?, ?) RETURNING watchlist_id`,
      [draft.userId, promptId, draft.title ?? `Prompt ${promptId}`, now]))!.watchlist_id;

    await t.run(`UPDATE prompt_drafts SET status = 'confirmed', confirmed_prompt_id = ?, updated_at = ? WHERE draft_id = ?`, [promptId, now, draftId]);

    return { promptId, watchlistId, parent };
  });

  const { promptId, watchlistId, parent } = await tool("warehouse.write", createPromptAndWatchlist, { spanName: "warehouse.write", argsOf: () => ({ tables: "prompts, prompt_conditions, watchlists, prompt_drafts" }), captureOutput: false })();

  // runWeeklyScreen does its own HTTP round-trip, so it must not hold the database transaction above open. A 422 from the engine must
  // still surface as if nothing had been written, per the confirm.test.ts
  // regression ("propagates a 422... without writing anything") — so on
  // failure here, undo the prompt/watchlist/conditions/draft-status change
  // rather than leaving a prompt with no run at all.
  let runId: number;
  try {
    ({ runId } = await runWeeklyScreen(raw, { promptId, asOf, kind: "catch_up" }, fetchFn));
  } catch (err) {
    await raw.tx(async (t) => {
      // prompt_drafts.confirmed_prompt_id references prompts(prompt_id), so it
      // must be cleared before the prompt row is deleted — deleting prompts
      // first trips a FOREIGN KEY constraint (prompt_drafts still pointing at
      // the row being removed).
      await t.run(`UPDATE prompt_drafts SET status = 'open', confirmed_prompt_id = NULL, updated_at = ? WHERE draft_id = ?`, [new Date().toISOString(), draftId]);
      await t.run("DELETE FROM watchlists WHERE watchlist_id = ?", [watchlistId]);
      await t.run("DELETE FROM prompt_conditions WHERE prompt_id = ?", [promptId]);
      await t.run("DELETE FROM prompts WHERE prompt_id = ?", [promptId]);
      // Undo the parent's premature supersede from inside createPromptAndWatchlist
      // too — a failed version-mint must leave the parent exactly as it was,
      // same "as if nothing had been written" contract as everything else here.
      if (parent) {
        await t.run("UPDATE prompts SET status = 'confirmed', closed_at = NULL WHERE prompt_id = ?", [parent.prompt_id]);
      }
    });
    throw err;
  }

  let selectionWarning: string | null = null;
  try {
    await registerArm(promptId, program, fetchFn);
    await runSelectEntry(raw, { promptId, runId }, fetchFn);
  } catch (err) {
    // The prompt/watchlist/run are already committed and real; a transient
    // engine problem here must not undo them (Review Focus item 1) — it only
    // means entries stay at their weekly-screen default status until the
    // next select_entry job (manual retry, or the next weekly catch-up) runs.
    selectionWarning = `prompt confirmed, but selection could not run yet: ${(err as Error).message}`;
  }

  // The parent's status was already flipped to 'superseded' inside the
  // transaction above (required there to satisfy ux_prompts_owner_spec).
  // All that's left here is telling the engine — best-effort, same
  // tolerance as the registerArm/runSelectEntry block above: a transient
  // engine problem must not undo prompt/watchlist/run data that is already
  // committed and real.
  if (parent) {
    try {
      await retireArm(parent.prompt_id, fetchFn);
    } catch (err) {
      selectionWarning = selectionWarning
        ? `${selectionWarning}; also failed to notify the engine that prompt ${parent.prompt_id} was retired: ${(err as Error).message}`
        : `prompt confirmed as version ${parent.version + 1}, but notifying the engine that prompt ${parent.prompt_id} was retired failed: ${(err as Error).message}`;
    }
  }

  // only a prompt that was really saved feeds the Reader's examples (plan §6); sharing it with the golden set needs the user's own OK
  await saveAccepted(raw, { userId: draft.userId, promptText: draft.promptText, program });
  return { promptId, watchlistId, selectionWarning };
}
