import { db } from "@/server/db/client";
import { getWatchlistView } from "@/server/watchlists";
import { withUser } from "@/server/auth/requireUser";
import { canReadWatchlist } from "@/server/auth/ownership";

export async function GET(req: Request, { params }: { params: { watchlistId: string } }) {
  const raw = db();
  return withUser(raw, req, (user) => {
    const id = Number(params.watchlistId);
    const view = canReadWatchlist(raw, user.userId, id) ? getWatchlistView(raw, id, user.userId) : null;
    if (!view) return Response.json({ error: "watchlist not found" }, { status: 404 });
    return Response.json(view);
  });
}
