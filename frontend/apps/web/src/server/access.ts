import type Database from "better-sqlite3";

export class ForbiddenError extends Error {}

export function canAccess(prompt: { owner_user_id: number; visibility: string }, userId: number): boolean {
  return prompt.owner_user_id === userId || prompt.visibility === "shared";
}

export function getAccessiblePrompt(raw: Database.Database, promptId: number, userId: number) {
  const prompt = raw.prepare("SELECT * FROM prompts WHERE prompt_id = ?").get(promptId) as any;
  if (!prompt) throw new Error(`prompt ${promptId} not found`);
  if (!canAccess(prompt, userId)) throw new ForbiddenError("prompt is private");
  return prompt;
}
