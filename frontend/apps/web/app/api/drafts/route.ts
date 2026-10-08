import { db } from "@/server/db/client";
import { createDraft } from "@/server/drafts";
import { getCurrentUserId } from "@/server/auth/currentUser";

export async function POST(req: Request) {
  const raw = db();
  const { draftId } = createDraft(raw, { userId: getCurrentUserId(raw, req) });
  return Response.json({ draft_id: draftId }, { status: 201 });
}
