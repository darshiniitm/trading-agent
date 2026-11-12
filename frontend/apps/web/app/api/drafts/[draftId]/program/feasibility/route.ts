import { z } from "zod";
import { db } from "@/server/db/client";
import { withUser } from "@/server/auth/requireUser";
import { ownsDraft } from "@/server/auth/ownership";
import { EngineError } from "@/server/engine/client";
import { engineErrorResponse } from "@/server/engine/respond";
import { feasibilityProgramDraft } from "@/server/compileProgramDraft";

export const dynamic = "force-dynamic";
const Body = z.object({ as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict();

// Never blocks the run: a failure here just means the chips are not shown.
async function handle(req: Request, { params }: { params: { draftId: string } }) {
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "body must be {as_of: YYYY-MM-DD}" }, { status: 400 });
  try {
    return Response.json(await feasibilityProgramDraft(db(), Number(params.draftId), body.data.as_of));
  } catch (err) {
    const down = engineErrorResponse(err);   // engine still loading / stopped: 503 with its state, not a 500
    if (down) return down;
    if (err instanceof EngineError) return Response.json(err.body as object, { status: err.status });
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function POST(req: Request, ctx: { params: { draftId: string } }) {
  const raw = db();
  return withUser(raw, req, async (user) => {
    if (!(await ownsDraft(raw, user.userId, Number(ctx.params.draftId)))) return Response.json({ error: "draft not found" }, { status: 404 });
    return handle(req, ctx);
  });
}
