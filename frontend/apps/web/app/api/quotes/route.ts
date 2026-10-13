import { rateLimited } from "@/server/rateLimit";
import { db } from "@/server/db/client";
import { withUser } from "@/server/auth/requireUser";
import { getQuotes } from "@/server/quotes";
import { EngineError } from "@/server/engine/client";

async function handle(req: Request) {
  const { symbols } = await req.json();
  try {
    const quotes = await getQuotes(symbols);
    return Response.json(quotes);
  } catch (err) {
    if (err instanceof EngineError) return Response.json(err.body, { status: err.status });
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function POST(req: Request) {
  return withUser(db(), req, (user) => rateLimited(user.userId, "data") ?? handle(req));
}
