import { db } from "@/server/db/client";
import { getWatchlistView } from "@/server/watchlists";
import { getCurrentUserId, AuthRequiredError } from "@/server/auth/currentUser";

export async function GET(req: Request, { params }: { params: { watchlistId: string } }) {
  const raw = db();
  let viewer: number | undefined;
  try { viewer = getCurrentUserId(raw, req); } catch (e) { if (!(e instanceof AuthRequiredError)) throw e; }
  const view = getWatchlistView(raw, Number(params.watchlistId), viewer);
  if (!view) return Response.json({ error: "watchlist not found" }, { status: 404 });
  return Response.json(view);
}
