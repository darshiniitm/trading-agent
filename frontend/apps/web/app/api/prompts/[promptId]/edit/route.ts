import { db } from "@/server/db/client";
import { createEditDraft } from "@/server/prompts";
import { withUser } from "@/server/auth/requireUser";
import { ownsPrompt } from "@/server/auth/ownership";

export async function POST(req: Request, { params }: { params: { promptId: string } }) {
  const raw = db();
  return withUser(raw, req, (user) => {
    const promptId = Number(params.promptId);
    if (!ownsPrompt(raw, user.userId, promptId)) return Response.json({ error: `prompt ${promptId} not found` }, { status: 404 });
    try {
      const { draftId } = createEditDraft(raw, { promptId, userId: user.userId });
      return Response.json({ draft_id: draftId }, { status: 201 });
    } catch (err) {
      const status = /not found/.test((err as Error).message) ? 404 : 409;
      return Response.json({ error: (err as Error).message }, { status });
    }
  });
}
