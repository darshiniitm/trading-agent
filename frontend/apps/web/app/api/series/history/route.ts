import { db } from "@/server/db/client";
import { rateLimited } from "@/server/rateLimit";
import { withUser } from "@/server/auth/requireUser";
import { EngineError, getHistory } from "@/server/engine/client";

export const dynamic = "force-dynamic";

// Weekly closes for a benchmark row's slim detail panel. Only index symbols the app knows about: not an open proxy.
export async function GET(req: Request) {
  const raw = db();
  return withUser(raw, req, async (user) => {
    const limited = rateLimited(user.userId, "data");
    if (limited) return limited;
    const symbol = new URL(req.url).searchParams.get("symbol") ?? "";
    const known = raw.prepare("SELECT kind FROM symbols WHERE symbol = ?").get(symbol) as { kind: string } | undefined;
    if (!known || known.kind !== "index") return Response.json({ error: "benchmark not found" }, { status: 404 });
    try {
      return Response.json(await getHistory(symbol));
    } catch (err) {
      if (err instanceof EngineError) return Response.json(err.body, { status: err.status });
      return Response.json({ error: `engine unreachable: ${(err as Error).message}` }, { status: 502 });
    }
  });
}
