import { db } from "@/server/db/client";
import { getEntryDetail } from "@/server/entryDetail";
import { removeEntry, setEntryNote } from "@/server/entryActions";
import { withUser } from "@/server/auth/requireUser";
import { canReadWatchlist } from "@/server/auth/ownership";

type Ctx = { params: { watchlistId: string; entryId: string } };
const notFound = () => Response.json({ error: "entry not found" }, { status: 404 });

// Read-only for anyone who can read the watchlist (owner, or a shared prompt); the entry must belong to it.
export async function GET(req: Request, { params }: Ctx) {
  const raw = db();
  return withUser(raw, req, async (user) => {
    const inList = await raw.get("SELECT 1 FROM watchlist_entries WHERE entry_id = ? AND watchlist_id = ?", [Number(params.entryId), Number(params.watchlistId)]);
    if (!inList || !(await canReadWatchlist(raw, user.userId, Number(params.watchlistId)))) return notFound();
    const detail = await getEntryDetail(raw, Number(params.entryId));
    return detail ? Response.json(detail) : notFound();
  });
}

export async function PATCH(req: Request, { params }: Ctx) {
  const raw = db();
  return withUser(raw, req, async (user) => {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.userNote !== "string") return Response.json({ error: "body must be {userNote: string}" }, { status: 400 });
    const ok = await setEntryNote(raw, { watchlistId: Number(params.watchlistId), entryId: Number(params.entryId), userId: user.userId, note: body.userNote });
    return ok ? Response.json({ ok: true }) : notFound();
  });
}

export async function DELETE(req: Request, { params }: Ctx) {
  const raw = db();
  return withUser(raw, req, async (user) => {
    const ok = await removeEntry(raw, { watchlistId: Number(params.watchlistId), entryId: Number(params.entryId), userId: user.userId });
    return ok ? Response.json({ ok: true }) : notFound();
  });
}
