import { db } from "@/server/db/client";
import { getDraft, updateDraft } from "@/server/drafts";

// Written only server-side, by the prompt compiler (compileProgramDraft). A client-sent value would let a
// hand-crafted request bypass the confirm gate (answered questions, liquidity) or forge 'prompt' provenance.
const SERVER_OWNED_KEYS = ["programJson", "programClausesJson", "programNormalised", "needsInputJson", "sourcePhrasesJson", "unsupportedJson", "specJson", "structure"];

export async function GET(_req: Request, { params }: { params: { draftId: string } }) {
  const draft = getDraft(db(), Number(params.draftId));
  if (!draft) return Response.json({ error: "draft not found" }, { status: 404 });
  return Response.json(draft);
}

// The generic save path: title, prompt text, hypothesis and kill criterion only.
export async function PATCH(req: Request, { params }: { params: { draftId: string } }) {
  const patch = await req.json();
  for (const key of SERVER_OWNED_KEYS) delete patch[key];
  try {
    const draft = updateDraft(db(), Number(params.draftId), patch);
    return Response.json(draft);
  } catch (err: any) {
    const status = /not found/.test(err.message) ? 404 : 400;
    return Response.json({ error: err.message }, { status });
  }
}
