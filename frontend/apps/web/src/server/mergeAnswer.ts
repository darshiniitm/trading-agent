import type Database from "better-sqlite3";
import { getDraft, updateDraft, type DraftRow } from "@/server/drafts";

function setAtPath(obj: any, path: string, value: unknown): void {
  const keys = path.split(".");
  let node = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (node[key] === undefined || node[key] === null) node[key] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    node = node[key];
  }
  node[keys[keys.length - 1]] = value;
}

export function applyAnswer(
  raw: Database.Database,
  draftId: number,
  { path, value }: { path: string; value: number | string }
): DraftRow {
  const draft = getDraft(raw, draftId);
  if (!draft) throw new Error(`draft ${draftId} not found`);
  if (!draft.spec) throw new Error("draft has no spec yet — compile or build it first");

  const needsInput = draft.needsInput ?? [];
  if (!needsInput.some((n) => n.path === path)) {
    throw new Error(`"${path}" is not a current needs_input item for draft ${draftId}`);
  }

  const spec = JSON.parse(JSON.stringify(draft.spec));
  setAtPath(spec, path, value);
  const remainingNeedsInput = needsInput.filter((n) => n.path !== path);

  return raw.transaction(() => {
    const existingAnswersRow = raw.prepare("SELECT answers_json FROM prompt_drafts WHERE draft_id = ?").get(draftId) as { answers_json: string | null };
    const answers = (existingAnswersRow.answers_json ? JSON.parse(existingAnswersRow.answers_json) : []) as { path: string; value: unknown }[];
    const nextAnswers = answers.filter((a) => a.path !== path).concat([{ path, value }]);
    raw.prepare("UPDATE prompt_drafts SET answers_json = ? WHERE draft_id = ?").run(JSON.stringify(nextAnswers), draftId);

    return updateDraft(raw, draftId, { specJson: JSON.stringify(spec), needsInputJson: JSON.stringify(remainingNeedsInput) });
  })();
}
