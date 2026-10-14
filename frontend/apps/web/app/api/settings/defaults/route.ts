import { z } from "zod";
import { db } from "@/server/db/client";
import { withUser } from "@/server/auth/requireUser";
import { getUserDefaults, setUserDefaults } from "@/server/userDefaults";

// The saved defaults the interpreter fills open slots from (docs/prompt-interpreter-spec.md §4, level 2).
const Body = z.object({
  price_source: z.enum(["open", "high", "low", "close"]),
  timeframe: z.enum(["1D", "1W", "1M"]),
  entry_recheck: z.enum(["monday_open", "friday_close"]),
  horizons_weeks: z.array(z.number().int().min(1)).min(1),
}).partial().strict();

export async function GET(req: Request) {
  const raw = db();
  return withUser(raw, req, (user) => Response.json(getUserDefaults(raw, user.userId)));
}

export async function PUT(req: Request) {
  const raw = db();
  return withUser(raw, req, async (user) => {
    const body = Body.safeParse(await req.json().catch(() => null));
    if (!body.success) return Response.json({ error: "body must be any of {price_source, timeframe, entry_recheck, horizons_weeks}" }, { status: 400 });
    try { return Response.json(setUserDefaults(raw, user.userId, body.data)); }
    catch (err) { return Response.json({ error: (err as Error).message }, { status: 400 }); }
  });
}
