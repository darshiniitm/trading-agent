import { db } from "@/server/db/client";
import { followPrompt, unfollowPrompt } from "@/server/follow";
import { withUser } from "@/server/auth/requireUser";
import { ForbiddenError } from "@/server/access";

// Another user's private prompt is reported as missing, never as forbidden, so ids can't be probed.
function errorResponse(error: unknown) {
  return Response.json({ error: error instanceof ForbiddenError ? "prompt not found" : (error as Error).message }, { status: 404 });
}

export async function POST(req: Request, { params }: { params: { promptId: string } }) {
  const raw = db();
  return withUser(raw, req, async (user) => {
    try { return Response.json(await followPrompt(raw, { promptId: Number(params.promptId), userId: user.userId }), { status: 201 }); } catch (error) { return errorResponse(error); }
  });
}
export async function DELETE(req: Request, { params }: { params: { promptId: string } }) {
  const raw = db();
  return withUser(raw, req, async (user) => {
    try { await unfollowPrompt(raw, { promptId: Number(params.promptId), userId: user.userId }); return Response.json({ ok: true }); } catch (error) { return errorResponse(error); }
  });
}
