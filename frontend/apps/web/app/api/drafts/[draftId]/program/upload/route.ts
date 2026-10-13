import { z } from "zod";
import { db } from "@/server/db/client";
import { withUser } from "@/server/auth/requireUser";
import { ownsDraft } from "@/server/auth/ownership";
import { EngineError } from "@/server/engine/client";
import { uploadForDraft } from "@/server/compileProgramDraft";

const Body = z.object({ name: z.string().min(1).max(200), text: z.string().min(1) }).strict();

async function handle(req: Request, { params }: { params: { draftId: string } }) {
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "body must be {name, text} (a CSV with a symbol column)" }, { status: 400 });
  try {
    return Response.json(await uploadForDraft(db(), Number(params.draftId), body.data.name, body.data.text));
  } catch (err) {
    if (err instanceof EngineError) return Response.json(err.body as object, { status: err.status });
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function POST(req: Request, ctx: { params: { draftId: string } }) {
  const raw = db();
  return withUser(raw, req, (user) => {
    if (!ownsDraft(raw, user.userId, Number(ctx.params.draftId))) return Response.json({ error: "draft not found" }, { status: 404 });
    return handle(req, ctx);
  });
}
