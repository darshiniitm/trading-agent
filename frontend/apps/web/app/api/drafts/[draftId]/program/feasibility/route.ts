import { z } from "zod";
import { db } from "@/server/db/client";
import { EngineError } from "@/server/engine/client";
import { feasibilityProgramDraft } from "@/server/compileProgramDraft";

export const dynamic = "force-dynamic";
const Body = z.object({ as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict();

// Never blocks the run: a failure here just means the chips are not shown.
export async function POST(req: Request, { params }: { params: { draftId: string } }) {
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "body must be {as_of: YYYY-MM-DD}" }, { status: 400 });
  try {
    return Response.json(await feasibilityProgramDraft(db(), Number(params.draftId), body.data.as_of));
  } catch (err) {
    if (err instanceof EngineError) return Response.json(err.body as object, { status: err.status });
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
