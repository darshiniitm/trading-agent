import type Database from "better-sqlite3";
import { getConditions, getStructures } from "@/server/engine/client";
import { compilePrompt, CompileError } from "@/server/compiler/compile";
import { DEFAULT_COMPILER_MODEL } from "@/server/compiler/callModel";
import { getDraft, updateDraft, type DraftRow } from "@/server/drafts";

// `compilePrompt`'s 4th parameter has a default value (`= {}`), so
// `Parameters<>` captures its type as `{ callModel?: CallModelFn } | undefined`.
// Checking a union against `extends { callModel?: infer F }` directly is not
// distributive here (the checked type isn't a naked type parameter), so the
// `| undefined` member makes the whole check fail to `never`. `NonNullable`
// strips that before the conditional runs.
type CompileModelFn = NonNullable<Parameters<typeof compilePrompt>[3]> extends { callModel?: infer F } ? F : never;

export async function compileDraft(
  raw: Database.Database,
  draftId: number,
  { fetchFn, callModel }: { fetchFn?: typeof fetch; callModel?: CompileModelFn } = {}
): Promise<DraftRow> {
  const draft = getDraft(raw, draftId);
  if (!draft) throw new Error(`draft ${draftId} not found`);
  if (!draft.promptText.trim()) throw new Error("draft has no prompt text yet");

  const [catalog, structures] = await Promise.all([getConditions(fetchFn) as Promise<any[]>, getStructures(fetchFn) as Promise<any[]>]);
  const now = new Date().toISOString();

  try {
    const { output, raw: rawText } = await compilePrompt(draft.promptText, catalog, structures, { callModel });
    raw.prepare(`INSERT INTO compilations (draft_id, model, raw_json, created_at) VALUES (?, ?, ?, ?)`)
      .run(draftId, DEFAULT_COMPILER_MODEL, JSON.stringify({ text: rawText }), now);

    if (output.structure === null) {
      const needsInput = [
        ...output.needs_input,
        { path: "structure", question: "Is this a weekly closing-price signal (literal), or does it look for something happening during the week or over a rolling window (t1_literal)?" },
      ];
      updateDraft(raw, draftId, {
        needsInputJson: JSON.stringify(needsInput),
        sourcePhrasesJson: JSON.stringify(output.source_phrases),
        unsupportedJson: JSON.stringify(output.unsupported),
      });
    } else {
      const spec = {
        spec_version: 4, structure: output.structure, timeframe: "1W" as const,
        selection_point: output.selection_point, conditions: output.conditions, stop: output.stop,
        risk_cap_pct: output.risk_cap_pct, near_miss: output.near_miss, t1_window: output.t1_window,
      };
      updateDraft(raw, draftId, {
        structure: output.structure,
        specJson: JSON.stringify(spec),
        needsInputJson: JSON.stringify(output.needs_input),
        sourcePhrasesJson: JSON.stringify(output.source_phrases),
        unsupportedJson: JSON.stringify(output.unsupported),
      });
    }
  } catch (err) {
    if (err instanceof CompileError) {
      raw.prepare(`INSERT INTO compilations (draft_id, model, raw_json, errors_json, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(draftId, DEFAULT_COMPILER_MODEL, JSON.stringify({ text: null }), JSON.stringify(err.errors), now);
    }
    throw err;
  }

  return getDraft(raw, draftId)!;
}
