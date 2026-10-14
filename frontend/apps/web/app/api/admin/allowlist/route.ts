import { z } from "zod";
import { db } from "@/server/db/client";
import { withUser } from "@/server/auth/requireUser";

const Email = z.object({ email: z.string().trim().toLowerCase().email() }).strict();

// Owner-only invite list (plan §3.5).
export async function GET(req: Request) {
  const raw = db();
  return withUser(raw, req, () => Response.json({
    allowlist: raw.prepare("SELECT a.email, a.created_at AS createdAt, u.user_id AS userId FROM signup_allowlist a LEFT JOIN users u ON lower(u.email) = lower(a.email) ORDER BY a.created_at").all(),
    users: raw.prepare("SELECT user_id AS userId, display_name AS displayName, email, role, status, last_login_at AS lastLoginAt FROM users ORDER BY user_id").all(),
  }), { owner: true });
}

export async function POST(req: Request) {
  const raw = db();
  return withUser(raw, req, async (user) => {
    const body = Email.safeParse(await req.json().catch(() => null));
    if (!body.success) return Response.json({ error: "enter a valid email" }, { status: 400 });
    raw.prepare("INSERT OR IGNORE INTO signup_allowlist (email, invited_by, created_at) VALUES (?, ?, ?)").run(body.data.email, user.userId, new Date().toISOString());
    return Response.json({ email: body.data.email }, { status: 201 });
  }, { owner: true });
}

export async function DELETE(req: Request) {
  const raw = db();
  return withUser(raw, req, async (user) => {
    const body = Email.safeParse(await req.json().catch(() => null));
    if (!body.success) return Response.json({ error: "enter a valid email" }, { status: 400 });
    if (body.data.email === user.email) return Response.json({ error: "you can't remove your own email" }, { status: 400 });
    raw.prepare("DELETE FROM signup_allowlist WHERE email = ?").run(body.data.email);
    return Response.json({ ok: true });
  }, { owner: true });
}

// Disable / re-enable a member (the owner cannot disable themselves).
export async function PATCH(req: Request) {
  const raw = db();
  return withUser(raw, req, async (user) => {
    const body = z.object({ userId: z.number().int(), status: z.enum(["active", "disabled"]) }).strict().safeParse(await req.json().catch(() => null));
    if (!body.success) return Response.json({ error: "body must be {userId, status}" }, { status: 400 });
    if (body.data.userId === user.userId) return Response.json({ error: "you can't change your own status" }, { status: 400 });
    const info = raw.prepare("UPDATE users SET status = ? WHERE user_id = ?").run(body.data.status, body.data.userId);
    return info.changes ? Response.json({ ok: true }) : Response.json({ error: "user not found" }, { status: 404 });
  }, { owner: true });
}
