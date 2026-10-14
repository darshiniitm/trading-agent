// Turns "the engine isn't ready" into a response the browser understands (503 + the engine's state) instead of a
// bare 500 / "fetch failed". Used by the routes that call the engine on a user's behalf.
import { isWarmingBody } from "@/lib/engineStatus";
import { EngineError } from "./client";
import { getSupervisor } from "./supervisor";

/** fetch() could not reach the engine at all (not started yet, stopped for being idle, or crashed). */
export function isConnectionError(err: unknown): boolean {
  const e = err as { message?: string; cause?: { code?: string } };
  return !!e && (/fetch failed|ECONNREFUSED|ECONNRESET|UND_ERR_SOCKET/i.test(`${e.message ?? ""} ${e.cause?.code ?? ""}`));
}

export function engineErrorResponse(err: unknown): Response | null {
  if (err instanceof EngineError) {
    return err.status === 503 && isWarmingBody(err.body) ? Response.json(err.body, { status: 503, headers: { "retry-after": "3" } }) : null;
  }
  if (isConnectionError(err)) {
    void getSupervisor().ensureEngine();   // bring it back (no-op when unmanaged)
    return Response.json({ detail: { engine: { state: "starting" } } }, { status: 503, headers: { "retry-after": "3" } });
  }
  return null;
}
