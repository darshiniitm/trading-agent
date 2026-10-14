import { db } from "@/server/db/client";
import { setVisibility } from "@/server/visibility";
import { withUser } from "@/server/auth/requireUser";
import { ForbiddenError } from "@/server/access";

export async function PATCH(req: Request, { params }: { params: { promptId: string } }) {
  const raw = db();
  return withUser(raw, req, async (user) => {
    try {
      const body = await req.json();
      const visibility = body.visibility === "shared" ? "shared" : body.visibility === "private" ? "private" : null;
      if (!visibility) return Response.json({ error: "visibility must be private or shared" }, { status: 400 });
      return Response.json(setVisibility(raw, { promptId: Number(params.promptId), userId: user.userId, visibility }));
    } catch (error) {
      return Response.json({ error: error instanceof ForbiddenError ? "prompt not found" : (error as Error).message }, { status: 404 });
    }
  });
}
