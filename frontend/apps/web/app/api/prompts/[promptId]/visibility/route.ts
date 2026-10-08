import { db } from "@/server/db/client";
import { setVisibility } from "@/server/visibility";
import { getCurrentUserId, AuthRequiredError } from "@/server/auth/currentUser";
import { ForbiddenError } from "@/server/access";

export async function PATCH(req: Request, { params }: { params: { promptId: string } }) {
  try {
    const raw = db();
    const body = await req.json();
    const visibility = body.visibility === "shared" ? "shared" : body.visibility === "private" ? "private" : null;
    if (!visibility) return Response.json({ error: "visibility must be private or shared" }, { status: 400 });
    return Response.json(setVisibility(raw, { promptId: Number(params.promptId), userId: getCurrentUserId(raw, req), visibility }));
  } catch (error) {
    if (error instanceof AuthRequiredError) return Response.json({ error: "sign in required" }, { status: 401 });
    if (error instanceof ForbiddenError) return Response.json({ error: error.message }, { status: 403 });
    return Response.json({ error: (error as Error).message }, { status: 404 });
  }
}
