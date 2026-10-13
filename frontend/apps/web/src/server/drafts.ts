import type Database from "better-sqlite3";
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

export function createDraft(raw: Database.Database, { userId, copiedFromPromptId }: { userId: number; copiedFromPromptId?: number }): { draftId: number } {
  const now = new Date().toISOString();
  const info = raw
    .prepare(
      `INSERT INTO prompt_drafts (user_id, copied_from_prompt_id, prompt_text, status, created_at, updated_at)
       VALUES (?, ?, '', 'open', ?, ?)`
    )
    .run(userId, copiedFromPromptId ?? null, now, now);
  return { draftId: Number(info.lastInsertRowid) };
}

export function getDraft(raw: Database.Database, draftId: number): DraftRow | null {
  const row = raw.prepare("SELECT * FROM prompt_drafts WHERE draft_id = ?").get(draftId);
  return row ? rowToDraft(row) : null;
}

type DraftPatch = Partial<{ title: string; promptText: string; hypothesis: string; killCriterion: string }>;

const COLUMN_BY_KEY: Record<keyof DraftPatch, string> = {
  title: "title",
  promptText: "prompt_text",
  hypothesis: "hypothesis",
  killCriterion: "kill_criterion",
};

export function updateDraft(raw: Database.Database, draftId: number, patch: DraftPatch): DraftRow {
  const existing = raw.prepare("SELECT draft_id FROM prompt_drafts WHERE draft_id = ?").get(draftId);
  if (!existing) throw new Error(`draft ${draftId} not found`);

  const keys = (Object.keys(patch) as (keyof DraftPatch)[]).filter((k) => patch[k] !== undefined);
  const unknown = Object.keys(patch).filter((k) => !(k in COLUMN_BY_KEY));
  if (unknown.length) throw new Error(`cannot update: ${unknown.join(", ")}`);
  if (keys.length > 0) {
    const assignments = keys.map((k) => `${COLUMN_BY_KEY[k]} = ?`).join(", ");
    const values = keys.map((k) => patch[k]);
    try {
      raw.prepare(`UPDATE prompt_drafts SET ${assignments}, updated_at = ? WHERE draft_id = ?`).run(...values, new Date().toISOString(), draftId);
    } catch (err: any) {
      if (String(err.message).includes("CHECK constraint failed") && keys.includes("promptText")) {
        throw new Error("prompt_text must be 2000 characters or fewer");
      }
      throw err;
    }
  }
  return getDraft(raw, draftId)!;
}

// v5 program state is server-owned: only the prompt compiler writes it (see compileProgramDraft.ts).
export function saveProgramState(raw: Database.Database, draftId: number, state: { program: ScreenProgram; clauses: ClauseView[] | null; normalised?: string | null }): DraftRow {
  const existing = getDraft(raw, draftId);
  if (!existing) throw new Error(`draft ${draftId} not found`);
  const clauses = state.clauses ?? existing.programClauses;
  raw.prepare(`UPDATE prompt_drafts SET program_json = ?, program_clauses_json = ?, program_normalised = ?, updated_at = ? WHERE draft_id = ?`)
    .run(JSON.stringify(state.program), clauses ? JSON.stringify(clauses) : null,
      state.normalised === undefined ? existing.programNormalised : state.normalised, new Date().toISOString(), draftId);
  return getDraft(raw, draftId)!;
}
