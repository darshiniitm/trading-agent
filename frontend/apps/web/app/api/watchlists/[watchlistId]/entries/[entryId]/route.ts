import { db } from "@/server/db/client";
import { getEntryDetail } from "@/server/entryDetail";
import { removeEntry, setEntryNote } from "@/server/entryActions";
import { getCurrentUserId, AuthRequiredError } from "@/server/auth/currentUser";

type Ctx = { params: { watchlistId: string; entryId: string } };

export async function GET(_req: Request, { params }: Ctx) {
  const detail = getEntryDetail(db(), Number(params.entryId));
  if (!detail) return Response.json({ error: "entry not found" }, { status: 404 });
  return Response.json(detail);
}

function viewer(req: Request) {
  try { return getCurrentUserId(db(), req); } catch (e) { if (e instanceof AuthRequiredError) return null; throw e; }
}

export async function PATCH(req: Request, { params }: Ctx) {
  const userId = viewer(req);
  if (userId === null) return Response.json({ error: "sign in required" }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body.userNote !== "string") return Response.json({ error: "body must be {userNote: string}" }, { status: 400 });
  const ok = setEntryNote(db(), { watchlistId: Number(params.watchlistId), entryId: Number(params.entryId), userId, note: body.userNote });
  return ok ? Response.json({ ok: true }) : Response.json({ error: "entry not found" }, { status: 404 });
}

export async function DELETE(req: Request, { params }: Ctx) {
  const userId = viewer(req);
  if (userId === null) return Response.json({ error: "sign in required" }, { status: 401 });
  const ok = removeEntry(db(), { watchlistId: Number(params.watchlistId), entryId: Number(params.entryId), userId });
  return ok ? Response.json({ ok: true }) : Response.json({ error: "entry not found" }, { status: 404 });
}
