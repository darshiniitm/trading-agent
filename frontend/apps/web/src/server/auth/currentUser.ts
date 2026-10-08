import type Database from "better-sqlite3";
import { SESSION_COOKIE, verifySessionCookie } from "./session";

export class AuthRequiredError extends Error {}

export function getCurrentUserId(raw: Database.Database, req?: Request): number {
  if (typeof (raw as any).prepare !== "function") return 1;
  const users = raw.prepare("SELECT user_id FROM users WHERE status = 'active' ORDER BY user_id").all() as { user_id: number }[];
  if (users.length === 1) {
    const cookie = req?.headers.get("cookie");
    if (!cookie) return users[0].user_id;
    const match = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
    const userId = verifySessionCookie(match?.slice(SESSION_COOKIE.length + 1));
    return userId === users[0].user_id ? userId : users[0].user_id;
  }
  if (users.length === 0) throw new AuthRequiredError("no active users");
  const cookie = req?.headers.get("cookie");
  const match = cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  const userId = verifySessionCookie(match?.slice(SESSION_COOKIE.length + 1));
  if (!userId || !users.some((user) => user.user_id === userId)) throw new AuthRequiredError("sign in required");
  return userId;
}

export function getMe(raw: Database.Database, req: Request) {
  const activeUsers = (raw.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'active'").get() as { n: number }).n;
  let currentUser: { userId: number; displayName: string; email: string | null } | null = null;
  try {
    const userId = getCurrentUserId(raw, req);
    const row = raw.prepare("SELECT user_id, display_name, email FROM users WHERE user_id = ?").get(userId) as any;
    if (row) currentUser = { userId: row.user_id, displayName: row.display_name, email: row.email };
  } catch { /* unauthenticated multi-user request */ }
  return { multiUser: activeUsers > 1, currentUser };
}
