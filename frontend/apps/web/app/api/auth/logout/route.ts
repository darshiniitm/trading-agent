import { SESSION_COOKIE } from "@/server/auth/session";

export async function POST() {
  const response = Response.json({ ok: true });
  response.headers.set("set-cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
  return response;
}
