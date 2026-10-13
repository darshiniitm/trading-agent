import { db } from "@/server/db/client";
import { withUser } from "@/server/auth/requireUser";
import { getSupervisor } from "@/server/engine/supervisor";

export const dynamic = "force-dynamic";

async function handle(_req: Request) {
  const sup = getSupervisor();
  await sup.retry();
  sup.beat();
  return Response.json(await sup.status(), { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  return withUser(db(), req, () => handle(req), { owner: true });
}
