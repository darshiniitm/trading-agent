import { db } from "@/server/db/client";
import { compileProgramDraft, viewOf } from "@/server/compileProgramDraft";
import { getDraft } from "@/server/drafts";
import { getUserDefaults } from "@/server/userDefaults";

export async function GET(_req: Request, { params }: { params: { draftId: string } }) {
  const draft = getDraft(db(), Number(params.draftId));
  if (!draft) return Response.json({ error: "draft not found" }, { status: 404 });
  if (!draft.program) return Response.json({ error: "no program compiled yet" }, { status: 404 });
  return Response.json(viewOf(draft, getUserDefaults(db(), draft.userId)));
}

export async function POST(_req: Request, { params }: { params: { draftId: string } }) {
  try {
    return Response.json(await compileProgramDraft(db(), Number(params.draftId)));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
