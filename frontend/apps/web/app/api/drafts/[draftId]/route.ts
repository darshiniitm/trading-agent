import { db } from "@/server/db/client";
import { getDraft, updateDraft } from "@/server/drafts";
import { withUser } from "@/server/auth/requireUser";
import { ownsDraft } from "@/server/auth/ownership";

// Written only server-side, by the prompt compiler (compileProgramDraft). A client-sent value would let a
// hand-crafted request bypass the confirm gate (answered questions, liquidity) or forge 'prompt' provenance.
const SERVER_OWNED_KEYS = ["programJson", "programClausesJson", "programNormalised", "needsInputJson", "sourcePhrasesJson", "unsupportedJson", "specJson", "structure"];

const notFound = () => Response.json({ error: "draft not found" }, { status: 404 });

export async function GET(req: Request, { params }: { params: { draftId: string } }) {
  const raw = db();
  return withUser(raw, req, (user) => {
    const id = Number(params.draftId);
    const draft = ownsDraft(raw, user.userId, id) ? getDraft(raw, id) : null;
    if (!draft) return notFound();
    return Response.json(draft);
  });
}

// The generic save path: title, prompt text, hypothesis and kill criterion only.
export async function PATCH(req: Request, { params }: { params: { draftId: string } }) {
  const raw = db();
  return withUser(raw, req, async (user) => {
    const id = Number(params.draftId);
    if (!ownsDraft(raw, user.userId, id)) return notFound();
    const patch = await req.json();
    for (const key of SERVER_OWNED_KEYS) delete patch[key];
    try {
      return Response.json(updateDraft(raw, id, patch));
    } catch (err: any) {
      const status = /not found/.test(err.message) ? 404 : 400;
      return Response.json({ error: err.message }, { status });
    }
  });
}
