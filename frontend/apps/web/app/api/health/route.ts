import { EngineError, getHealth } from "@/server/engine/client";
import { isConnectionError } from "@/server/engine/respond";
import { getSupervisor } from "@/server/engine/supervisor";

// Thin proxy over the engine's /health so the browser can learn the engine's
// latest bar date (used as the as_of for dry-run/confirm — the engine grades
// horizons only on an exact bar-date match, never on "today").
// force-dynamic: a GET handler that never reads its Request is otherwise
// statically evaluated once at build time by Next.js 14.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(await getHealth());
  } catch (err) {
    if (err instanceof EngineError) return Response.json(err.body, { status: err.status });
    if (isConnectionError(err)) void getSupervisor().ensureEngine();
    return Response.json({ error: `engine unreachable: ${(err as Error).message}` }, { status: 502 });
  }
}
