import { db } from "@/server/db/client";
import { withUser } from "@/server/auth/requireUser";
import { getUserBenchmarks, setUserBenchmarks, ViewDataError, computeMetrics } from "@/server/viewData";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const raw = db();
  return withUser(raw, req, (user) => Response.json({ symbols: getUserBenchmarks(raw, user.userId) }));
}

export async function PUT(req: Request) {
  const raw = db();
  return withUser(raw, req, async (user) => {
    let body: any;
    try { body = await req.json(); } catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
    if (!body || !Array.isArray(body.symbols) || body.symbols.some((s: unknown) => typeof s !== "string")) return Response.json({ error: "symbols must be a list of index tickers" }, { status: 400 });
    try {
      const symbols = setUserBenchmarks(raw, user.userId, body.symbols);
      void computeMetrics(raw, symbols).catch(() => {});   // a newly added benchmark gets its metrics without waiting for the job
      return Response.json({ symbols });
    } catch (err) {
      if (err instanceof ViewDataError) return Response.json({ error: err.message }, { status: 400 });
      throw err;
    }
  });
}
