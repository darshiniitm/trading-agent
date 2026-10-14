import { db } from "@/server/db/client";
import { withUser } from "@/server/auth/requireUser";
import { getSupervisor } from "@/server/engine/supervisor";

// The engine's state for the header pill and the "loading market data" panel. Every call from a browser tab doubles as a
// heartbeat: the supervisor stops an idle engine and brings it back on the next beat.
export const dynamic = "force-dynamic";

async function handle(_req: Request) {
  const sup = getSupervisor();
  sup.beat();
  const status = await sup.status();
  return Response.json(status.state === "error" ? { ...status, log: status.log ?? sup.recentLog() } : status, { headers: { "cache-control": "no-store" } });
}

export async function GET(req: Request) {
  return withUser(db(), req, () => handle(req));
}
