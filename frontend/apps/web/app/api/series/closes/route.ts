import { getRecentCloses } from "@/server/closes";
import { getHealth } from "@/server/engine/client";

export async function POST(req: Request) {
  const { symbols, weeks } = await req.json();
  if (!Array.isArray(symbols)) return Response.json({ error: "symbols must be a list" }, { status: 400 });
  // The last bar date keys the cache, so a new weekly bar naturally invalidates it.
  const lastBar = await getHealth().then((h: any) => String(h?.last_bar_date ?? "")).catch(() => "");
  return Response.json(await getRecentCloses(symbols.map(String), Number(weeks) || 12, fetch, lastBar));
}
