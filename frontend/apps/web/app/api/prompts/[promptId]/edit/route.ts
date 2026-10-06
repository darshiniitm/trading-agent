import { db } from "@/server/db/client";
import { createEditDraft } from "@/server/prompts";

const OWNER_USER_ID = 1;

export async function POST(_req: Request, { params }: { params: { promptId: string } }) {
  try {
    const { draftId } = createEditDraft(db(), { promptId: Number(params.promptId), userId: OWNER_USER_ID });
    return Response.json({ draft_id: draftId }, { status: 201 });
  } catch (err) {
    const status = /not found/.test((err as Error).message) ? 404 : 409;
    return Response.json({ error: (err as Error).message }, { status });
  }
}
