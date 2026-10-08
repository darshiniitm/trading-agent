import { db } from "@/server/db/client";
import { createEditDraft } from "@/server/prompts";
import { getCurrentUserId, AuthRequiredError } from "@/server/auth/currentUser";

export async function POST(req: Request, { params }: { params: { promptId: string } }) {
  try {
    const raw = db();
    const { draftId } = createEditDraft(raw, { promptId: Number(params.promptId), userId: getCurrentUserId(raw, req) });
    return Response.json({ draft_id: draftId }, { status: 201 });
  } catch (err) {
    if (err instanceof AuthRequiredError) return Response.json({ error: "sign in required" }, { status: 401 });
    const status = /not found/.test((err as Error).message) ? 404 : 409;
    return Response.json({ error: (err as Error).message }, { status });
  }
}
