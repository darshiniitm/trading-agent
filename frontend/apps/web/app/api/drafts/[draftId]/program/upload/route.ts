import { z } from "zod";
import { db } from "@/server/db/client";
import { EngineError } from "@/server/engine/client";
import { uploadForDraft } from "@/server/compileProgramDraft";

const Body = z.object({ name: z.string().min(1).max(200), text: z.string().min(1) }).strict();

export async function POST(req: Request, { params }: { params: { draftId: string } }) {
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "body must be {name, text} (a CSV with a symbol column)" }, { status: 400 });
  try {
    return Response.json(await uploadForDraft(db(), Number(params.draftId), body.data.name, body.data.text));
  } catch (err) {
    if (err instanceof EngineError) return Response.json(err.body as object, { status: err.status });
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
