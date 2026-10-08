import { db } from "@/server/db/client";
import { followPrompt, unfollowPrompt } from "@/server/follow";
import { getCurrentUserId, AuthRequiredError } from "@/server/auth/currentUser";
import { ForbiddenError } from "@/server/access";

function errorResponse(error: unknown) {
  if (error instanceof AuthRequiredError) return Response.json({ error: "sign in required" }, { status: 401 });
  if (error instanceof ForbiddenError) return Response.json({ error: error.message }, { status: 403 });
  return Response.json({ error: (error as Error).message }, { status: 404 });
}

export async function POST(req: Request, { params }: { params: { promptId: string } }) {
  try { const raw = db(); return Response.json(followPrompt(raw, { promptId: Number(params.promptId), userId: getCurrentUserId(raw, req) }), { status: 201 }); } catch (error) { return errorResponse(error); }
}
export async function DELETE(req: Request, { params }: { params: { promptId: string } }) {
  try { const raw = db(); unfollowPrompt(raw, { promptId: Number(params.promptId), userId: getCurrentUserId(raw, req) }); return Response.json({ ok: true }); } catch (error) { return errorResponse(error); }
}
