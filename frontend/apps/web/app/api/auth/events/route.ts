import { db } from "@/server/db/client";
import { withUser } from "@/server/auth/requireUser";
import { recordAuthEvent } from "@/server/auth/ensureAppUser";

// The browser can only report events that happen client-side at Supabase; one allowed value for now.
export async function POST(req: Request) {
  const raw = db();
  return withUser(raw, req, async (user) => {
    const body = await req.json().catch(() => null);
    if (body?.event !== "password_reset") return Response.json({ error: "unsupported event" }, { status: 400 });
    await recordAuthEvent(raw, { userId: user.userId, email: user.email, event: "password_reset", provider: "email", ip: req.headers.get("x-forwarded-for"), userAgent: req.headers.get("user-agent") });
    return Response.json({ ok: true });
  });
}
