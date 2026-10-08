import { db } from "@/server/db/client";
import { listExplore } from "@/server/explore";
import { getCurrentUserId, AuthRequiredError } from "@/server/auth/currentUser";

export async function GET(req: Request) {
  try {
    const raw = db(); const url = new URL(req.url);
    const sortParam = url.searchParams.get("sort");
    const sort = sortParam === "followers" || sortParam === "graded_weeks" ? sortParam : undefined;
    return Response.json(listExplore(raw, { userId: getCurrentUserId(raw, req), structure: url.searchParams.get("structure") || undefined, usesCondition: url.searchParams.get("uses_condition") || undefined, sort }));
  } catch (error) { if (error instanceof AuthRequiredError) return Response.json({ error: "sign in required" }, { status: 401 }); throw error; }
}
