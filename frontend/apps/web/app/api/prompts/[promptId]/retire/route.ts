import { db } from "@/server/db/client";
import { retirePrompt } from "@/server/prompts";
import { withUser } from "@/server/auth/requireUser";
import { ownsPrompt } from "@/server/auth/ownership";

export async function POST(req: Request, { params }: { params: { promptId: string } }) {
  const raw = db();
  return withUser(raw, req, async (user) => {
    const promptId = Number(params.promptId);
    if (!ownsPrompt(raw, user.userId, promptId)) return Response.json({ error: `prompt ${promptId} not found` }, { status: 404 });
    try {
      const { warning } = await retirePrompt(raw, promptId);
      return Response.json({ prompt_id: promptId, status: "retired", warning });
    } catch (err) {
      const status = /not found/.test((err as Error).message) ? 404 : 409;
      return Response.json({ error: (err as Error).message }, { status });
    }
  });
}
