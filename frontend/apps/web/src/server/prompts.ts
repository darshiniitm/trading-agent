import type { Db } from "./db/pg";
import { retireArm } from "@/server/engine/client";
import { programOf } from "@/server/programOf";

export async function createEditDraft(raw: Db, { promptId, userId }: { promptId: number; userId: number }): Promise<{ draftId: number }> {
  const prompt = await raw.get("SELECT * FROM prompts WHERE prompt_id = ?", [promptId]);
  if (!prompt) throw new Error(`prompt ${promptId} not found`);
  if (prompt.status === "superseded") throw new Error(`prompt ${promptId} is already superseded`);
  if (prompt.status === "retired") throw new Error(`prompt ${promptId} is already retired`);

  const now = new Date().toISOString();
  const row = await raw.get<{ draft_id: number }>(
    `INSERT INTO prompt_drafts
       (user_id, parent_prompt_id, title, prompt_text, program_json, hypothesis, kill_criterion, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?) RETURNING draft_id`,
    [userId, promptId, prompt.title, prompt.prompt_text, JSON.stringify(programOf(prompt.spec_json)), prompt.hypothesis, prompt.kill_criterion, now, now]
  );
  return { draftId: row!.draft_id };
}

// Retiring is a local decision first: the prompt row is flipped to 'retired'
// (and keeps every record it has), then the engine is told best-effort. An
// engine failure doesn't undo or fail the retire — it comes back as a
// warning, the same convention confirmDraft uses for selectionWarning.
export async function retirePrompt(
  raw: Db,
  promptId: number,
  fetchFn?: typeof fetch
): Promise<{ warning: string | null }> {
  const prompt = await raw.get<{ status: string }>("SELECT status FROM prompts WHERE prompt_id = ?", [promptId]);
  if (!prompt) throw new Error(`prompt ${promptId} not found`);
  // A superseded prompt already has its closing state (and closed_at) from
  // the edit that replaced it; retiring it would overwrite that history.
  if (prompt.status === "superseded") throw new Error(`prompt ${promptId} is already superseded`);
  if (prompt.status === "retired") throw new Error(`prompt ${promptId} is already retired`);

  const now = new Date().toISOString();
  await raw.run("UPDATE prompts SET status = 'retired', closed_at = ? WHERE prompt_id = ?", [now, promptId]);
  try {
    await retireArm(promptId, fetchFn);
    return { warning: null };
  } catch (err) {
    return { warning: `prompt ${promptId} retired, but notifying the engine failed: ${(err as Error).message}` };
  }
}
