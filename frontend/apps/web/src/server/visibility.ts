import type { Db } from "./db/pg";
import { ForbiddenError } from "./access";

export async function setVisibility(raw: Db, { promptId, userId, visibility }: { promptId: number; userId: number; visibility: "private" | "shared" }) {
  const prompt = await raw.get<{ owner_user_id: number; visibility: string }>("SELECT owner_user_id, visibility FROM prompts WHERE prompt_id = ?", [promptId]);
  if (!prompt) throw new Error(`prompt ${promptId} not found`);
  if (prompt.owner_user_id !== userId) throw new ForbiddenError("only the owner can change visibility");
  await raw.tx(async (t) => {
    await t.run("UPDATE prompts SET visibility = ? WHERE prompt_id = ?", [visibility, promptId]);
    if (prompt.visibility === "shared" && visibility === "private") {
      await t.run("UPDATE watchlists SET archived_at = ? WHERE prompt_id = ? AND user_id <> ? AND archived_at IS NULL", [new Date().toISOString(), promptId, userId]);
    }
  });
  return { promptId, visibility };
}
