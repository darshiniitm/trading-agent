import { getQuotes } from "@/server/quotes";
import { EngineError } from "@/server/engine/client";

export async function POST(req: Request) {
  const { symbols } = await req.json();
  try {
    const quotes = await getQuotes(symbols);
    return Response.json(quotes);
  } catch (err) {
    if (err instanceof EngineError) return Response.json(err.body, { status: err.status });
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
