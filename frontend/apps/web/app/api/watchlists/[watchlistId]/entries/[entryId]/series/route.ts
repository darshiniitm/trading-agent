import { db } from "@/server/db/client";
import { getEntrySeries } from "@/server/entrySeries";
import { EngineError } from "@/server/engine/client";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { watchlistId: string; entryId: string } }) {
  try {
    const series = await getEntrySeries(db(), Number(params.watchlistId), Number(params.entryId));
    if (!series) return Response.json({ error: "entry not found" }, { status: 404 });
    return Response.json(series);
  } catch (err) {
    if (err instanceof EngineError) return Response.json(err.body, { status: err.status });
    return Response.json({ error: `engine unreachable: ${(err as Error).message}` }, { status: 502 });
  }
}
