import { db } from "@/server/db/client";
import { confirmDraft } from "@/server/confirm";
import { EngineError } from "@/server/engine/client";
import { withUser } from "@/server/auth/requireUser";
import { ownsDraft } from "@/server/auth/ownership";

export async function POST(req: Request, { params }: { params: { draftId: string } }) {
  const raw = db();
  return withUser(raw, req, async (user) => {
    const id = Number(params.draftId);
    if (!(await ownsDraft(raw, user.userId, id))) return Response.json({ error: "draft not found" }, { status: 404 });
    const { as_of } = await req.json();
    try {
      const { promptId, watchlistId, selectionWarning } = await confirmDraft(raw, id, as_of);
      return Response.json({ prompt_id: promptId, watchlist_id: watchlistId, selection_warning: selectionWarning }, { status: 201 });
    } catch (err) {
      if (err instanceof EngineError) return Response.json(err.body, { status: err.status });
      const status = /already confirmed|abandoned|already have a confirmed prompt/.test((err as Error).message) ? 409 : 400;
      return Response.json({ error: (err as Error).message }, { status });
    }
  });
}
