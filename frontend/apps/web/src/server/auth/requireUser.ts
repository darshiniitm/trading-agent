import type { Db } from "../db/pg";
import { ensureOwnerSeeded } from "../db/seed";
import { supabaseIdentity, type IdentityResolver } from "./identity";
import { ensureAppUser, type AppUser } from "./ensureAppUser";
import { AccountDeniedError, AuthRequiredError, OwnerOnlyError } from "./errors";

export { AuthRequiredError, AccountDeniedError, OwnerOnlyError } from "./errors";

let resolver: IdentityResolver = supabaseIdentity;
/** Test seam only. */
export function setIdentityResolver(next: IdentityResolver | null) { resolver = next ?? supabaseIdentity; }

/**
 * The only way a route learns who is calling. No cookie, a forged cookie, an unknown identity or a
 * unknown client all end in AuthRequiredError (401); there is no single-user or "user 1" fallback.
 */
export async function requireUser(raw: Db, req: Request): Promise<AppUser> {
  const identity = await resolver(req);
  if (!identity) throw new AuthRequiredError("sign in required");
  await ensureOwnerSeeded(raw);
  return ensureAppUser(raw, identity, { ip: req.headers.get("x-forwarded-for"), userAgent: req.headers.get("user-agent") });
}

export async function requireOwner(raw: Db, req: Request): Promise<AppUser> {
  const user = await requireUser(raw, req);
  if (user.role !== "owner") throw new OwnerOnlyError("owner only");
  return user;
}

/** Maps auth failures to responses; returns null for errors that are not auth's to handle. */
export function authErrorResponse(error: unknown): Response | null {
  if (error instanceof AuthRequiredError) return Response.json({ error: "sign in required" }, { status: 401 });
  if (error instanceof AccountDeniedError) return Response.json({ error: error.reason === "not_invited" ? "this account has not been invited" : "this account is not allowed", reason: error.reason }, { status: 403 });
  if (error instanceof OwnerOnlyError) return Response.json({ error: "owner only" }, { status: 403 });
  return null;
}

/** Wrap a route body: auth errors become 401/403, everything else keeps its own handling. */
export async function withUser(raw: Db, req: Request, fn: (user: AppUser) => Promise<Response> | Response, opts: { owner?: boolean } = {}): Promise<Response> {
  let user: AppUser;
  try { user = opts.owner ? await requireOwner(raw, req) : await requireUser(raw, req); }
  catch (e) { const r = authErrorResponse(e); if (r) return r; throw e; }
  return fn(user);
}
