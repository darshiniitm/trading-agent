import { db } from "@/server/db/client";
import { copyPromptToDraft } from "@/server/copyPrompt";
import { withUser } from "@/server/auth/requireUser";
import { ForbiddenError } from "@/server/access";

export async function POST(req: Request, { params }: { params: { promptId: string } }) {
  const raw = db();
  return withUser(raw, req, (user) => {
    try { return Response.json({ draft_id: copyPromptToDraft(raw, { promptId: Number(params.promptId), userId: user.userId }).draftId }, { status: 201 }); }
    catch (error) { return Response.json({ error: error instanceof ForbiddenError ? "prompt not found" : (error as Error).message }, { status: 404 }); }
  });
}
