import { db } from "@/server/db/client";
import { getEntrySeries } from "@/server/entrySeries";
import { EngineError } from "@/server/engine/client";
import { withUser } from "@/server/auth/requireUser";
import { canReadWatchlist } from "@/server/auth/ownership";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: { watchlistId: string; entryId: string } }) {
  const raw = db();
  return withUser(raw, req, async (user) => {
    if (!(await canReadWatchlist(raw, user.userId, Number(params.watchlistId)))) return Response.json({ error: "entry not found" }, { status: 404 });
    try {
      const series = await getEntrySeries(raw, Number(params.watchlistId), Number(params.entryId));
      if (!series) return Response.json({ error: "entry not found" }, { status: 404 });
      return Response.json(series);
    } catch (err) {
      if (err instanceof EngineError) return Response.json(err.body, { status: err.status });
      return Response.json({ error: `engine unreachable: ${(err as Error).message}` }, { status: 502 });
    }
  });
}
