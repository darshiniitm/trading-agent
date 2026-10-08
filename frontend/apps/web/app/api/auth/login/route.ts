import { db } from "@/server/db/client";
import { verifyPassword } from "@/server/auth/users";
import { createSessionCookie, SESSION_COOKIE } from "@/server/auth/session";

export async function POST(req: Request) {
  const body = await req.json();
  const result = await verifyPassword(db(), { email: String(body.email ?? ""), password: String(body.password ?? "") });
  if (!result) return Response.json({ error: "invalid email or password" }, { status: 401 });
  const response = Response.json({ user_id: result.userId });
  response.headers.set("set-cookie", `${SESSION_COOKIE}=${createSessionCookie(result.userId)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`);
  return response;
}
