import { db } from "@/server/db/client";
import { getWatchlistView } from "@/server/watchlists";

export async function GET(_req: Request, { params }: { params: { watchlistId: string } }) {
  const view = getWatchlistView(db(), Number(params.watchlistId));
  if (!view) return Response.json({ error: "watchlist not found" }, { status: 404 });
  return Response.json(view);
}
