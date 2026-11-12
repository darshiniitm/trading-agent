import type { Db } from "./db/pg";

export class ForbiddenError extends Error {}

export function canAccess(prompt: { owner_user_id: number; visibility: string }, userId: number): boolean {
  return prompt.owner_user_id === userId || prompt.visibility === "shared";
}

export async function getAccessiblePrompt(raw: Db, promptId: number, userId: number) {
  const prompt = await raw.get("SELECT * FROM prompts WHERE prompt_id = ?", [promptId]);
  if (!prompt) throw new Error(`prompt ${promptId} not found`);
  if (!canAccess(prompt, userId)) throw new ForbiddenError("prompt is private");
  return prompt;
}
