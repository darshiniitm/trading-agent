import type { Db } from "../db/pg";
import { requireUser } from "./requireUser";

export async function getMe(raw: Db, req: Request) {
  const activeUsers = (await raw.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE status = 'active'"))!.n;
  let currentUser: { userId: number; displayName: string; email: string | null; role: string } | null = null;
  let denied: string | null = null;
  try {
    const user = await requireUser(raw, req);
    currentUser = { userId: user.userId, displayName: user.displayName, email: user.email, role: user.role };
  } catch (e: any) { if (e?.reason) denied = e.reason; /* else: unauthenticated */ }
  return { multiUser: activeUsers > 1, currentUser, denied };
}
