import { z } from "zod";
import { db } from "@/server/db/client";
import { withUser } from "@/server/auth/requireUser";
import { ownsDraft } from "@/server/auth/ownership";
import { EngineError } from "@/server/engine/client";
import { engineErrorResponse } from "@/server/engine/respond";
import { screenProgramDraft } from "@/server/compileProgramDraft";

const Body = z.object({ as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), table: z.boolean().optional() }).strict();

async function handle(req: Request, { params }: { params: { draftId: string } }) {
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "body must be {as_of: YYYY-MM-DD, table?: boolean}" }, { status: 400 });
  try {
    return Response.json(await screenProgramDraft(db(), Number(params.draftId), body.data.as_of, undefined, body.data.table === true));
  } catch (err) {
    const down = engineErrorResponse(err);   // engine still loading / stopped: 503 with its state, not a 500
    if (down) return down;
    if (err instanceof EngineError) {
      // a plain-text engine failure (e.g. a 500) is shown with context, not as a bare "Internal Server Error"
      const body = typeof err.body === "string" ? { error: `The screening engine failed (${err.status}): ${err.body}. Check the engine log.` } : (err.body as object);
      return Response.json(body, { status: err.status });
    }
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
