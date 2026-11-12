import { EngineError, getHealth } from "@/server/engine/client";
import { isConnectionError } from "@/server/engine/respond";
import { getSupervisor } from "@/server/engine/supervisor";
import { db } from "@/server/db/client";
import { appHealth } from "@/server/health";

// Thin proxy over the engine's /health so the browser can learn the engine's
// latest bar date (used as the as_of for dry-run/confirm — the engine grades
// horizons only on an exact bar-date match, never on "today").
// force-dynamic: a GET handler that never reads its Request is otherwise
// statically evaluated once at build time by Next.js 14.
export const dynamic = "force-dynamic";

// ?deep=1 is the deployment check (docs/netlify-production-plan.md §12): database, engine and LLM model in one answer,
// 503 unless the app can actually serve. Public like the plain probe, so it reports booleans and fixed phrases only.
async function deepHealth() {
  const app = await appHealth(db());
  let engine: { ok: boolean; warm?: string; error?: string };
  try {
    const h = (await getHealth()) as { warm?: { state?: string } };
    engine = { ok: true, warm: h?.warm?.state ?? "ready" };
  } catch {
    engine = { ok: false, error: "engine unreachable" };
  }
  const ok = app.ok && engine.ok;
  return Response.json({ ok, db: app.db, engine, model: app.model }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}

export async function GET(req: Request) {
  if (new URL(req.url).searchParams.get("deep") === "1") return deepHealth();
  try {
    return Response.json(await getHealth());
  } catch (err) {
    if (err instanceof EngineError) return Response.json(err.body, { status: err.status });
    if (isConnectionError(err)) void getSupervisor().ensureEngine();
    return Response.json({ error: `engine unreachable: ${(err as Error).message}` }, { status: 502 });
  }
}
