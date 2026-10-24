import { db } from "@/server/db/client";
import { withUser } from "@/server/auth/requireUser";
import { canReadWatchlist } from "@/server/auth/ownership";
import { setViewPrefs, ViewDataError } from "@/server/viewData";

export async function PATCH(req: Request, { params }: { params: { watchlistId: string } }) {
  const raw = db();
  return withUser(raw, req, async (user) => {
    const id = Number(params.watchlistId);
    if (!canReadWatchlist(raw, user.userId, id)) return Response.json({ error: "watchlist not found" }, { status: 404 });
    let body: any;
    try { body = await req.json(); } catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
    if (!body || typeof body !== "object") return Response.json({ error: "invalid body" }, { status: 400 });
    const { view, hiddenColumns, currency, techTimeframe, compact } = body;
    try {
      return Response.json(setViewPrefs(raw, user.userId, id, Object.fromEntries(Object.entries({ view, hiddenColumns, currency, techTimeframe, compact }).filter(([, v]) => v !== undefined))));
    } catch (err) {
      if (err instanceof ViewDataError) return Response.json({ error: err.message }, { status: 400 });
      throw err;
    }
  });
}
