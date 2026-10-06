import type Database from "better-sqlite3";
import { retireArm } from "@/server/engine/client";

export function createEditDraft(raw: Database.Database, { promptId, userId }: { promptId: number; userId: number }): { draftId: number } {
  const prompt = raw.prepare("SELECT * FROM prompts WHERE prompt_id = ?").get(promptId) as any;
  if (!prompt) throw new Error(`prompt ${promptId} not found`);
  if (prompt.status === "superseded") throw new Error(`prompt ${promptId} is already superseded`);
  if (prompt.status === "retired") throw new Error(`prompt ${promptId} is already retired`);

  const now = new Date().toISOString();
  const info = raw
    .prepare(
      `INSERT INTO prompt_drafts
         (user_id, parent_prompt_id, title, prompt_text, structure, spec_json, hypothesis, kill_criterion, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
    )
    .run(userId, promptId, prompt.title, prompt.prompt_text, prompt.structure, prompt.spec_json, prompt.hypothesis, prompt.kill_criterion, now, now);
  return { draftId: Number(info.lastInsertRowid) };
}

export async function retirePrompt(raw: Database.Database, promptId: number, fetchFn?: typeof fetch): Promise<void> {
  const prompt = raw.prepare("SELECT status FROM prompts WHERE prompt_id = ?").get(promptId) as { status: string } | undefined;
  if (!prompt) throw new Error(`prompt ${promptId} not found`);
  if (prompt.status === "retired") throw new Error(`prompt ${promptId} is already retired`);

  const now = new Date().toISOString();
  raw.prepare("UPDATE prompts SET status = 'retired', closed_at = ? WHERE prompt_id = ?").run(now, promptId);
  await retireArm(promptId, fetchFn);
}
