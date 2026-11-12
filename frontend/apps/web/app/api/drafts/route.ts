import { db } from "@/server/db/client";
import { createDraft } from "@/server/drafts";
import { withUser } from "@/server/auth/requireUser";
import { deleteDrafts } from "@/server/deleteDrafts";

export async function POST(req: Request) {
  const raw = db();
  return withUser(raw, req, async (user) => {
    const { draftId } = await createDraft(raw, { userId: user.userId });
    return Response.json({ draft_id: draftId }, { status: 201 });
  });
}

// Delete the caller's unconfirmed drafts: {ids: number[]} for a selection, {all: true} for every one.
export async function DELETE(req: Request) {
  const raw = db();
  return withUser(raw, req, async (user) => {
    const body = await req.json().catch(() => null);
    const ids = Array.isArray(body?.ids) && body.ids.every((n: unknown) => Number.isInteger(n)) ? (body.ids as number[]) : null;
    if (!ids && body?.all !== true) return Response.json({ error: "body must be {ids: number[]} or {all: true}" }, { status: 400 });
    return Response.json({ deleted: await deleteDrafts(raw, user.userId, ids ?? undefined) });
  });
}
