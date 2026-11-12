import { z } from "zod";
import { db } from "@/server/db/client";
import { withUser } from "@/server/auth/requireUser";

export async function PATCH(req: Request) {
  const raw = db();
  return withUser(raw, req, async (user) => {
    const body = z.object({ displayName: z.string().trim().min(1).max(80) }).strict().safeParse(await req.json().catch(() => null));
    if (!body.success) return Response.json({ error: "enter a name (1-80 characters)" }, { status: 400 });
    await raw.run("UPDATE users SET display_name = ? WHERE user_id = ?", [body.data.displayName, user.userId]);
    return Response.json({ displayName: body.data.displayName });
  });
}
