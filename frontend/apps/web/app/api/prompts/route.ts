import { db } from "@/server/db/client";
import { listPrompts } from "@/server/listPrompts";
import { getCurrentUserId, AuthRequiredError } from "@/server/auth/currentUser";

export async function GET(req: Request) {
  try {
    const viewParam = new URL(req.url).searchParams.get("view");
    const view = viewParam === "drafts" || viewParam === "following" ? viewParam : "mine";
    const raw = db();
    return Response.json(listPrompts(raw, { userId: getCurrentUserId(raw, req), view }));
  } catch (error) { if (error instanceof AuthRequiredError) return Response.json({ error: "sign in required" }, { status: 401 }); throw error; }
}
