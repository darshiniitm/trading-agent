import { db } from "@/server/db/client";
import { createUser } from "@/server/auth/users";
import { createSessionCookie, SESSION_COOKIE } from "@/server/auth/session";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { userId } = await createUser(db(), { displayName: String(body.displayName ?? ""), email: String(body.email ?? ""), password: String(body.password ?? "") });
    const response = Response.json({ user_id: userId }, { status: 201 });
    response.headers.set("set-cookie", `${SESSION_COOKIE}=${createSessionCookie(userId)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`);
    return response;
  } catch (error) { return Response.json({ error: (error as Error).message }, { status: 400 }); }
}
