import { db } from "@/server/db/client";
import { createDraft } from "@/server/drafts";

const OWNER_USER_ID = 1;

export async function POST() {
  const { draftId } = createDraft(db(), { userId: OWNER_USER_ID });
  return Response.json({ draft_id: draftId }, { status: 201 });
}
