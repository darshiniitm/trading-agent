import { db } from "@/server/db/client";
import { listPrompts } from "@/server/listPrompts";

const OWNER_USER_ID = 1;

export async function GET(req: Request) {
  const view = new URL(req.url).searchParams.get("view") === "drafts" ? "drafts" : "mine";
  return Response.json(listPrompts(db(), { userId: OWNER_USER_ID, view }));
}
