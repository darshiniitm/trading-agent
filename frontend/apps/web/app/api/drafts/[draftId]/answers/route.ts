import { db } from "@/server/db/client";
import { applyAnswer } from "@/server/mergeAnswer";

export async function POST(req: Request, { params }: { params: { draftId: string } }) {
  const { path, value } = await req.json();
  try {
    const draft = applyAnswer(db(), Number(params.draftId), { path, value });
    return Response.json({ spec: draft.spec, needs_input: draft.needsInput });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
