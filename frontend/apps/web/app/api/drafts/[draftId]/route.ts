import { db } from "@/server/db/client";
import { getDraft, updateDraft } from "@/server/drafts";
import { manualEditInvalidatesProvenance } from "@/server/provenance";

// Written only server-side, by compileDraft()/applyAnswer(). A client-sent
// value would let a hand-crafted request bypass the confirm gate (empty
// needs_input/unsupported) or forge 'prompt' provenance (source phrases).
const SERVER_OWNED_KEYS = ["needsInputJson", "sourcePhrasesJson", "unsupportedJson"];

export async function GET(_req: Request, { params }: { params: { draftId: string } }) {
  const draft = getDraft(db(), Number(params.draftId));
  if (!draft) return Response.json({ error: "draft not found" }, { status: 404 });
  return Response.json(draft);
}

// The generic, manual-edit save path. Unlike applyAnswer()'s path-scoped
// writes (which must keep source phrases for the paths they didn't touch),
// a manual spec save that changes a traced value clears ALL of the draft's
// source phrases, so confirm never records an edited value as 'prompt'-
// origin with its original phrase (see src/server/provenance.ts).
export async function PATCH(req: Request, { params }: { params: { draftId: string } }) {
  const patch = await req.json();
  for (const key of SERVER_OWNED_KEYS) delete patch[key];
  try {
    const draftId = Number(params.draftId);
    if (typeof patch.specJson === "string") {
      const existing = getDraft(db(), draftId);
      if (existing && manualEditInvalidatesProvenance(existing.spec as any, existing.sourcePhrases, patch.specJson)) {
        patch.sourcePhrasesJson = null;
      }
    }
    const draft = updateDraft(db(), draftId, patch);
    return Response.json(draft);
  } catch (err: any) {
    const status = /not found/.test(err.message) ? 404 : 400;
    return Response.json({ error: err.message }, { status });
  }
}
