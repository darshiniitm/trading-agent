import type Database from "better-sqlite3";
import { getAccessiblePrompt } from "./access";
import { createDraft, saveProgramState, updateDraft } from "./drafts";
import { programOf } from "./programOf";

export function copyPromptToDraft(raw: Database.Database, { promptId, userId }: { promptId: number; userId: number }) {
  const prompt = getAccessiblePrompt(raw, promptId, userId);
  const source = raw.prepare("SELECT program_clauses_json, program_normalised FROM prompt_drafts WHERE draft_id = ?").get(prompt.draft_id) as any;
  const { draftId } = createDraft(raw, { userId, copiedFromPromptId: promptId });
  updateDraft(raw, draftId, { title: prompt.title, promptText: prompt.prompt_text, hypothesis: prompt.hypothesis, killCriterion: prompt.kill_criterion });
  saveProgramState(raw, draftId, {
    program: programOf(prompt.spec_json),
    clauses: source?.program_clauses_json ? JSON.parse(source.program_clauses_json) : null,
    normalised: source?.program_normalised ?? null,
  });
  return { draftId };
}
