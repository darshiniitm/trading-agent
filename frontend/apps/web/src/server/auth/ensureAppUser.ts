import type Database from "better-sqlite3";
import type { AuthIdentity } from "./identity";
import { AccountDeniedError } from "./errors";

export type AppUser = { userId: number; role: "owner" | "member"; email: string | null; displayName: string };
export type AuthEvent = "login" | "logout" | "link" | "signup" | "denied" | "password_reset";

export function recordAuthEvent(raw: Database.Database, e: { userId?: number | null; email?: string | null; event: AuthEvent; provider?: string | null; ip?: string | null; userAgent?: string | null }) {
  raw.prepare("INSERT INTO auth_events (user_id, email, event, provider, ip, user_agent, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(e.userId ?? null, e.email ?? null, e.event, e.provider ?? null, e.ip ?? null, e.userAgent ?? null, new Date().toISOString());
}

const toAppUser = (r: any): AppUser => ({ userId: r.user_id, role: r.role, email: r.email, displayName: r.display_name });

/**
 * Idempotent identity -> app user mapping, the one code path for every sign-in method (plan §3.3).
 * An unverified email never links and never creates a row.
 */
export function ensureAppUser(raw: Database.Database, identity: AuthIdentity, ctx: { ip?: string | null; userAgent?: string | null } = {}): AppUser {
  const now = new Date().toISOString();
  const deny = (reason: "not_invited" | "disabled" | "email_conflict"): never => {
    recordAuthEvent(raw, { email: identity.email, event: "denied", provider: identity.provider, ...ctx });
    throw new AccountDeniedError(reason);
  };

  const byAuth = raw.prepare("SELECT * FROM users WHERE auth_user_id = ?").get(identity.authUserId) as any;
  if (byAuth) {
    if (byAuth.status !== "active") return deny("disabled");
    raw.prepare("UPDATE users SET last_login_at = ? WHERE user_id = ?").run(now, byAuth.user_id);
    return toAppUser(byAuth);
  }

  if (!identity.email || !identity.emailVerified) return deny("not_invited");

  const byEmail = raw.prepare("SELECT * FROM users WHERE lower(email) = ?").get(identity.email) as any;
  if (byEmail) {
    if (byEmail.auth_user_id) return deny("email_conflict");   // that email already belongs to a different identity
    if (byEmail.status !== "active") return deny("disabled");
    raw.prepare("UPDATE users SET auth_user_id = ?, last_login_at = ? WHERE user_id = ?").run(identity.authUserId, now, byEmail.user_id);
    recordAuthEvent(raw, { userId: byEmail.user_id, email: identity.email, event: "link", provider: identity.provider, ...ctx });
    return toAppUser(byEmail);
  }

  const invited = raw.prepare("SELECT 1 FROM signup_allowlist WHERE email = ?").get(identity.email);
  if (!invited) return deny("not_invited");
  const name = identity.displayName ?? identity.email.split("@")[0];
  const info = raw.prepare("INSERT INTO users (display_name, email, auth_user_id, role, status, created_at, last_login_at) VALUES (?, ?, ?, 'member', 'active', ?, ?)")
    .run(name, identity.email, identity.authUserId, now, now);
  const userId = Number(info.lastInsertRowid);
  recordAuthEvent(raw, { userId, email: identity.email, event: "signup", provider: identity.provider, ...ctx });
  return { userId, role: "member", email: identity.email, displayName: name };
}

/** OWNER_EMAIL claims the seeded Owner row (so its prompts carry over) and is always on the allowlist. */
export function seedOwnerEmail(raw: Database.Database, ownerEmail = process.env.OWNER_EMAIL) {
  const email = ownerEmail?.trim().toLowerCase();
  if (!email) return;
  const owner = raw.prepare("SELECT user_id, email FROM users WHERE role = 'owner' ORDER BY user_id LIMIT 1").get() as { user_id: number; email: string | null } | undefined;
  if (owner && !owner.email) raw.prepare("UPDATE users SET email = ? WHERE user_id = ? AND NOT EXISTS (SELECT 1 FROM users WHERE lower(email) = ?)").run(email, owner.user_id, email);
  raw.prepare("INSERT OR IGNORE INTO signup_allowlist (email, invited_by, created_at) VALUES (?, ?, ?)").run(email, owner?.user_id ?? null, new Date().toISOString());
}
