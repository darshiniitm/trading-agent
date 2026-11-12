import type { Db } from "./db/pg";
import type { ClauseView, ScreenProgram } from "spec";

export type DraftRow = {
  draftId: number;
  userId: number;
  parentPromptId: number | null;
  title: string | null;
  promptText: string;
  hypothesis: string | null;
  killCriterion: string | null;
  status: "open" | "confirmed" | "abandoned";
  confirmedPromptId: number | null;
  copiedFromPromptId: number | null;
  // v5 program state: written only server-side by the prompt compiler (never by a client PATCH)
  program: ScreenProgram | null;
  programClauses: ClauseView[] | null;
  programNormalised: string | null;
  createdAt: string;
  updatedAt: string;
};

function rowToDraft(row: any): DraftRow {
  return {
    draftId: row.draft_id,
    userId: row.user_id,
    parentPromptId: row.parent_prompt_id,
    title: row.title,
    promptText: row.prompt_text,
    hypothesis: row.hypothesis,
    killCriterion: row.kill_criterion,
    status: row.status,
    confirmedPromptId: row.confirmed_prompt_id,
    copiedFromPromptId: row.copied_from_prompt_id ?? null,
    program: row.program_json ? JSON.parse(row.program_json) : null,
    programClauses: row.program_clauses_json ? JSON.parse(row.program_clauses_json) : null,
    programNormalised: row.program_normalised ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createDraft(raw: Db, { userId, copiedFromPromptId }: { userId: number; copiedFromPromptId?: number }): Promise<{ draftId: number }> {
  const now = new Date().toISOString();
  const row = await raw.get<{ draft_id: number }>(
    `INSERT INTO prompt_drafts (user_id, copied_from_prompt_id, prompt_text, status, created_at, updated_at)
     VALUES (?, ?, '', 'open', ?, ?) RETURNING draft_id`,
    [userId, copiedFromPromptId ?? null, now, now]
  );
  return { draftId: row!.draft_id };
}

export async function getDraft(raw: Db, draftId: number): Promise<DraftRow | null> {
  const row = await raw.get("SELECT * FROM prompt_drafts WHERE draft_id = ?", [draftId]);
  return row ? rowToDraft(row) : null;
}

type DraftPatch = Partial<{ title: string; promptText: string; hypothesis: string; killCriterion: string }>;

const COLUMN_BY_KEY: Record<keyof DraftPatch, string> = {
  title: "title",
  promptText: "prompt_text",
  hypothesis: "hypothesis",
  killCriterion: "kill_criterion",
};

export async function updateDraft(raw: Db, draftId: number, patch: DraftPatch): Promise<DraftRow> {
  const existing = await raw.get("SELECT draft_id FROM prompt_drafts WHERE draft_id = ?", [draftId]);
  if (!existing) throw new Error(`draft ${draftId} not found`);

  const keys = (Object.keys(patch) as (keyof DraftPatch)[]).filter((k) => patch[k] !== undefined);
  const unknown = Object.keys(patch).filter((k) => !(k in COLUMN_BY_KEY));
  if (unknown.length) throw new Error(`cannot update: ${unknown.join(", ")}`);
  if (keys.length > 0) {
    const assignments = keys.map((k) => `${COLUMN_BY_KEY[k]} = ?`).join(", ");
    const values = keys.map((k) => patch[k]);
    try {
      await raw.run(`UPDATE prompt_drafts SET ${assignments}, updated_at = ? WHERE draft_id = ?`, [...values, new Date().toISOString(), draftId]);
    } catch (err: any) {
      if (/check constraint/i.test(String(err.message)) && keys.includes("promptText")) {
        throw new Error("prompt_text must be 2000 characters or fewer");
      }
      throw err;
    }
  }
  return (await getDraft(raw, draftId))!;
}

// v5 program state is server-owned: only the prompt compiler writes it (see compileProgramDraft.ts).
export async function saveProgramState(raw: Db, draftId: number, state: { program: ScreenProgram; clauses: ClauseView[] | null; normalised?: string | null }): Promise<DraftRow> {
  const existing = await getDraft(raw, draftId);
  if (!existing) throw new Error(`draft ${draftId} not found`);
  const clauses = state.clauses ?? existing.programClauses;
  await raw.run(`UPDATE prompt_drafts SET program_json = ?, program_clauses_json = ?, program_normalised = ?, updated_at = ? WHERE draft_id = ?`,
    [JSON.stringify(state.program), clauses ? JSON.stringify(clauses) : null,
      state.normalised === undefined ? existing.programNormalised : state.normalised, new Date().toISOString(), draftId]);
  return (await getDraft(raw, draftId))!;
}
