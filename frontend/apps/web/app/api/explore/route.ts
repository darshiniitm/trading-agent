import { db } from "@/server/db/client";
import { listExplore } from "@/server/explore";
import { withUser } from "@/server/auth/requireUser";

export async function GET(req: Request) {
  const raw = db();
  return withUser(raw, req, (user) => {
    const url = new URL(req.url);
    const sortParam = url.searchParams.get("sort");
    const sort = sortParam === "followers" || sortParam === "graded_weeks" ? sortParam : undefined;
    return Response.json(listExplore(raw, { userId: user.userId, structure: url.searchParams.get("structure") || undefined, usesCondition: url.searchParams.get("uses_condition") || undefined, sort }));
  });
}
