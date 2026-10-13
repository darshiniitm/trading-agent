import type Database from "better-sqlite3";
import { ForbiddenError } from "./access";

export function setVisibility(raw: Database.Database, { promptId, userId, visibility }: { promptId: number; userId: number; visibility: "private" | "shared" }) {
  const prompt = raw.prepare("SELECT owner_user_id, visibility FROM prompts WHERE prompt_id = ?").get(promptId) as { owner_user_id: number; visibility: string } | undefined;
  if (!prompt) throw new Error(`prompt ${promptId} not found`);
  if (prompt.owner_user_id !== userId) throw new ForbiddenError("only the owner can change visibility");
  raw.transaction(() => {
    raw.prepare("UPDATE prompts SET visibility = ? WHERE prompt_id = ?").run(visibility, promptId);
    if (prompt.visibility === "shared" && visibility === "private") {
      raw.prepare("UPDATE watchlists SET archived_at = ? WHERE prompt_id = ? AND user_id <> ? AND archived_at IS NULL").run(new Date().toISOString(), promptId, userId);
    }
  })();
  return { promptId, visibility };
}
