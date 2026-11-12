import { db } from "@/server/db/client";
import { rateLimited } from "@/server/rateLimit";
import { withUser } from "@/server/auth/requireUser";
import { canReadWatchlist } from "@/server/auth/ownership";
import { loadWatchlistViews } from "@/server/viewsApi";

export const dynamic = "force-dynamic";

async function handle(req: Request, watchlistId: number, userId: number, refresh: boolean) {
  const raw = db();
  if (!(await canReadWatchlist(raw, userId, watchlistId))) return Response.json({ error: "watchlist not found" }, { status: 404 });
  const tf = new URL(req.url).searchParams.get("tf") ?? "1D";
  if (tf !== "1D" && tf !== "1W") return Response.json({ error: "tf must be 1D or 1W" }, { status: 400 });
  return Response.json(await loadWatchlistViews(raw, watchlistId, userId, tf, { refresh }));
}

export async function GET(req: Request, { params }: { params: { watchlistId: string } }) {
  return withUser(db(), req, (user) => rateLimited(user.userId, "data") ?? handle(req, Number(params.watchlistId), user.userId, false));
}

// "Refresh metrics": recompute this watchlist's symbols now, then return the fresh payload.
export async function POST(req: Request, { params }: { params: { watchlistId: string } }) {
  return withUser(db(), req, (user) => rateLimited(user.userId, "data") ?? handle(req, Number(params.watchlistId), user.userId, true));
}
