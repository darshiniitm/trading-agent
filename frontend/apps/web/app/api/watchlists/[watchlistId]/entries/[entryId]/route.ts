import { db } from "@/server/db/client";
import { getEntryDetail } from "@/server/entryDetail";

export async function GET(_req: Request, { params }: { params: { watchlistId: string; entryId: string } }) {
  const detail = getEntryDetail(db(), Number(params.entryId));
  if (!detail) return Response.json({ error: "entry not found" }, { status: 404 });
  return Response.json(detail);
}
