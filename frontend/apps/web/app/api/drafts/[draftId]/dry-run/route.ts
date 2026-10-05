import { db } from "@/server/db/client";
import { dryRunDraft } from "@/server/dryrun";
import { EngineError } from "@/server/engine/client";

export async function POST(req: Request, { params }: { params: { draftId: string } }) {
  const { as_of } = await req.json();
  try {
    const result = await dryRunDraft(db(), Number(params.draftId), as_of);
    return Response.json(result);
  } catch (err) {
    if (err instanceof EngineError) return Response.json(err.body, { status: err.status });
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
