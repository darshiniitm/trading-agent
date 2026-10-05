import { db } from "@/server/db/client";
import { confirmDraft } from "@/server/confirm";
import { EngineError } from "@/server/engine/client";

export async function POST(req: Request, { params }: { params: { draftId: string } }) {
  const { as_of } = await req.json();
  try {
    const { promptId, watchlistId } = await confirmDraft(db(), Number(params.draftId), as_of);
    return Response.json({ prompt_id: promptId, watchlist_id: watchlistId }, { status: 201 });
  } catch (err) {
    if (err instanceof EngineError) return Response.json(err.body, { status: err.status });
    const status = /already confirmed|abandoned/.test((err as Error).message) ? 409 : 400;
    return Response.json({ error: (err as Error).message }, { status });
  }
}
