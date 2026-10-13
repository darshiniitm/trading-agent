import { db } from "@/server/db/client";
import { listPrompts } from "@/server/listPrompts";
import { withUser } from "@/server/auth/requireUser";

export async function GET(req: Request) {
  const raw = db();
  return withUser(raw, req, (user) => {
    const viewParam = new URL(req.url).searchParams.get("view");
    const view = viewParam === "drafts" || viewParam === "following" ? viewParam : "mine";
    return Response.json(listPrompts(raw, { userId: user.userId, view }));
  });
}
