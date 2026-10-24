import type { Db } from "../db/pg";
import type { AuthIdentity } from "./identity";
import { AccountDeniedError } from "./errors";

export type AppUser = { userId: number; role: "owner" | "member"; email: string | null; displayName: string };
export type AuthEvent = "login" | "logout" | "link" | "signup" | "denied" | "password_reset";

export async function recordAuthEvent(raw: Db, e: { userId?: number | null; email?: string | null; event: AuthEvent; provider?: string | null; ip?: string | null; userAgent?: string | null }) {
  await raw.run("INSERT INTO auth_events (user_id, email, event, provider, ip, user_agent, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [e.userId ?? null, e.email ?? null, e.event, e.provider ?? null, e.ip ?? null, e.userAgent ?? null, new Date().toISOString()]);
}

const toAppUser = (r: any): AppUser => ({ userId: r.user_id, role: r.role, email: r.email, displayName: r.display_name });

/**
 * Idempotent identity -> app user mapping, the one code path for every sign-in method (plan §3.3).
 * An unverified email never links and never creates a row.
 */
export async function ensureAppUser(raw: Db, identity: AuthIdentity, ctx: { ip?: string | null; userAgent?: string | null } = {}): Promise<AppUser> {
  const now = new Date().toISOString();
  const deny = async (reason: "not_invited" | "disabled" | "email_conflict"): Promise<never> => {
    await recordAuthEvent(raw, { email: identity.email, event: "denied", provider: identity.provider, ...ctx });
    throw new AccountDeniedError(reason);
  };

  const byAuth = await raw.get("SELECT * FROM users WHERE auth_user_id = ?", [identity.authUserId]);
  if (byAuth) {
    if (byAuth.status !== "active") return deny("disabled");
    await raw.run("UPDATE users SET last_login_at = ? WHERE user_id = ?", [now, byAuth.user_id]);
    return toAppUser(byAuth);
  }

  if (!identity.email || !identity.emailVerified) return deny("not_invited");

  const byEmail = await raw.get("SELECT * FROM users WHERE lower(email) = ?", [identity.email]);
  if (byEmail) {
    if (byEmail.auth_user_id) return deny("email_conflict");   // that email already belongs to a different identity
    if (byEmail.status !== "active") return deny("disabled");
    await raw.run("UPDATE users SET auth_user_id = ?, last_login_at = ? WHERE user_id = ?", [identity.authUserId, now, byEmail.user_id]);
    await recordAuthEvent(raw, { userId: byEmail.user_id, email: identity.email, event: "link", provider: identity.provider, ...ctx });
    return toAppUser(byEmail);
  }

  const invited = await raw.get("SELECT 1 FROM signup_allowlist WHERE email = ?", [identity.email]);
  if (!invited) return deny("not_invited");
  const name = identity.displayName ?? identity.email.split("@")[0];
  const created = await raw.get<{ user_id: number }>(
    "INSERT INTO users (display_name, email, auth_user_id, role, status, created_at, last_login_at) VALUES (?, ?, ?, 'member', 'active', ?, ?) RETURNING user_id",
    [name, identity.email, identity.authUserId, now, now]);
  const userId = created!.user_id;
  await recordAuthEvent(raw, { userId, email: identity.email, event: "signup", provider: identity.provider, ...ctx });
  return { userId, role: "member", email: identity.email, displayName: name };
}

/** OWNER_EMAIL claims the seeded Owner row (so its prompts carry over) and is always on the allowlist. */
export async function seedOwnerEmail(raw: Db, ownerEmail = process.env.OWNER_EMAIL) {
  const email = ownerEmail?.trim().toLowerCase();
  if (!email) return;
  const owner = await raw.get<{ user_id: number; email: string | null }>("SELECT user_id, email FROM users WHERE role = 'owner' ORDER BY user_id LIMIT 1");
  if (owner && !owner.email) await raw.run("UPDATE users SET email = ? WHERE user_id = ? AND NOT EXISTS (SELECT 1 FROM users WHERE lower(email) = ?)", [email, owner.user_id, email]);
  await raw.run("INSERT INTO signup_allowlist (email, invited_by, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING", [email, owner?.user_id ?? null, new Date().toISOString()]);
}
