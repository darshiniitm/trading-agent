import { db } from "@/server/db/client";
import { getDraft, updateDraft } from "@/server/drafts";

export async function GET(_req: Request, { params }: { params: { draftId: string } }) {
  const draft = getDraft(db(), Number(params.draftId));
  if (!draft) return Response.json({ error: "draft not found" }, { status: 404 });
  return Response.json(draft);
}

export async function PATCH(req: Request, { params }: { params: { draftId: string } }) {
  const patch = await req.json();
  try {
    const draft = updateDraft(db(), Number(params.draftId), patch);
    return Response.json(draft);
  } catch (err: any) {
    const status = /not found/.test(err.message) ? 404 : 400;
    return Response.json({ error: err.message }, { status });
  }
}
