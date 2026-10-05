import type Database from "better-sqlite3";
import type { ScreenSpec } from "spec";

export type DraftRow = {
  draftId: number;
  userId: number;
  title: string | null;
  promptText: string;
  structure: "literal" | "t1_literal" | null;
  spec: ScreenSpec | null;
  hypothesis: string | null;
  killCriterion: string | null;
  status: "open" | "confirmed" | "abandoned";
  confirmedPromptId: number | null;
  createdAt: string;
  updatedAt: string;
};

function rowToDraft(row: any): DraftRow {
  return {
    draftId: row.draft_id,
    userId: row.user_id,
    title: row.title,
    promptText: row.prompt_text,
    structure: row.structure,
    spec: row.spec_json ? JSON.parse(row.spec_json) : null,
    hypothesis: row.hypothesis,
    killCriterion: row.kill_criterion,
    status: row.status,
    confirmedPromptId: row.confirmed_prompt_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createDraft(raw: Database.Database, { userId }: { userId: number }): { draftId: number } {
  const now = new Date().toISOString();
  const info = raw
    .prepare(
      `INSERT INTO prompt_drafts (user_id, prompt_text, status, created_at, updated_at)
       VALUES (?, '', 'open', ?, ?)`
    )
    .run(userId, now, now);
  return { draftId: Number(info.lastInsertRowid) };
}

export function getDraft(raw: Database.Database, draftId: number): DraftRow | null {
  const row = raw.prepare("SELECT * FROM prompt_drafts WHERE draft_id = ?").get(draftId);
  return row ? rowToDraft(row) : null;
}

type DraftPatch = Partial<{
  title: string;
  promptText: string;
  structure: "literal" | "t1_literal";
  specJson: string;
  hypothesis: string;
  killCriterion: string;
}>;

const COLUMN_BY_KEY: Record<keyof DraftPatch, string> = {
  title: "title",
  promptText: "prompt_text",
  structure: "structure",
  specJson: "spec_json",
  hypothesis: "hypothesis",
  killCriterion: "kill_criterion",
};

export function updateDraft(raw: Database.Database, draftId: number, patch: DraftPatch): DraftRow {
  const existing = raw.prepare("SELECT draft_id FROM prompt_drafts WHERE draft_id = ?").get(draftId);
  if (!existing) throw new Error(`draft ${draftId} not found`);

  const keys = Object.keys(patch) as (keyof DraftPatch)[];
  if (keys.length > 0) {
    const assignments = keys.map((k) => `${COLUMN_BY_KEY[k]} = ?`).join(", ");
    const values = keys.map((k) => patch[k]);
    try {
      raw
        .prepare(`UPDATE prompt_drafts SET ${assignments}, updated_at = ? WHERE draft_id = ?`)
        .run(...values, new Date().toISOString(), draftId);
    } catch (err: any) {
      if (String(err.message).includes("CHECK constraint failed") && keys.includes("promptText")) {
        throw new Error("prompt_text must be 2000 characters or fewer");
      }
      throw err;
    }
  }
  return getDraft(raw, draftId)!;
}
