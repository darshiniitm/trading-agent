import { db } from "@/server/db/client";
import { copyPromptToDraft } from "@/server/copyPrompt";
import { getCurrentUserId, AuthRequiredError } from "@/server/auth/currentUser";
import { ForbiddenError } from "@/server/access";

export async function POST(req: Request, { params }: { params: { promptId: string } }) {
  try { const raw = db(); const result = copyPromptToDraft(raw, { promptId: Number(params.promptId), userId: getCurrentUserId(raw, req) }); return Response.json({ draft_id: result.draftId }, { status: 201 }); }
  catch (error) { if (error instanceof AuthRequiredError) return Response.json({ error: "sign in required" }, { status: 401 }); if (error instanceof ForbiddenError) return Response.json({ error: error.message }, { status: 403 }); return Response.json({ error: (error as Error).message }, { status: 404 }); }
}
