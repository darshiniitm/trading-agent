import { db } from "@/server/db/client";
import { compileDraft } from "@/server/compileDraft";
import { CompileError } from "@/server/compiler/compile";

export async function POST(_req: Request, { params }: { params: { draftId: string } }) {
  try {
    const draft = await compileDraft(db(), Number(params.draftId));
    // compileDraft always writes a spec on success; its structure is this
    // compile's reading (null = unresolved, pending a "structure" answer),
    // whereas the column can still hold a previous compile's structure.
    return Response.json({
      structure: draft.spec ? draft.spec.structure : draft.structure, spec: draft.spec, needs_input: draft.needsInput,
      source_phrases: draft.sourcePhrases, unsupported: draft.unsupported,
    });
  } catch (err) {
    if (err instanceof CompileError) return Response.json({ errors: err.errors }, { status: 422 });
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
