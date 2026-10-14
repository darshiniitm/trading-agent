import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { ensureAppUser } from "@/server/auth/ensureAppUser";
import { AccountDeniedError } from "@/server/auth/errors";
import { requireUser, requireOwner, setIdentityResolver, AuthRequiredError, OwnerOnlyError } from "@/server/auth/requireUser";
import { identityFromSupabaseUser, type AuthIdentity } from "@/server/auth/identity";
import { safeNext } from "@/lib/authRedirect";
import { signupSchema, resetSchema } from "@/lib/authSchemas";

const id = (over: Partial<AuthIdentity> = {}): AuthIdentity => ({ authUserId: "uuid-1", email: "a@example.com", emailVerified: true, displayName: "Ann", provider: "google", ...over });
const req = () => new Request("http://localhost/api/x");
const invite = (raw: ReturnType<typeof createTestDb>, email: string) => raw.prepare("INSERT INTO signup_allowlist (email, created_at) VALUES (?, 'now')").run(email);
const events = (raw: ReturnType<typeof createTestDb>) => (raw.prepare("SELECT event FROM auth_events ORDER BY event_id").all() as any[]).map((r) => r.event);

describe("requireUser", () => {
  const defaultResolver = async () => ({ authUserId: "test-owner-uuid", email: "owner@example.com", emailVerified: true, displayName: "Owner", provider: "email" });
  afterEach(() => setIdentityResolver(defaultResolver));

  it("with exactly one active user, an anonymous or forged-cookie request is 401, not that user", async () => {
    const raw = createTestDb(); ensureOwnerUser(raw);
    setIdentityResolver(async () => null);
    await expect(requireUser(raw, req())).rejects.toBeInstanceOf(AuthRequiredError);
    const forged = new Request("http://localhost", { headers: { cookie: "prompt_screener_session=1.9999999999999.sig; sb-x-auth-token=forged" } });
    await expect(requireUser(raw, forged)).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it("a valid identity resolves to the numeric user id, and the owner's seeded row carries over", async () => {
    const raw = createTestDb(); const ownerId = ensureOwnerUser(raw);
    const user = await requireUser(raw, req());
    expect(user).toMatchObject({ userId: ownerId, role: "owner", email: "owner@example.com" });
    expect(typeof user.userId).toBe("number");
  });

  it("rejects an unknown identity (not invited) and a disabled user", async () => {
    const raw = createTestDb(); ensureOwnerUser(raw);
    setIdentityResolver(async () => id({ email: "stranger@example.com" }));
    await expect(requireUser(raw, req())).rejects.toMatchObject({ reason: "not_invited" });
    raw.prepare("UPDATE users SET status = 'disabled' WHERE role = 'owner'").run();
    setIdentityResolver(defaultResolver);
    await expect(requireUser(raw, req())).rejects.toBeInstanceOf(AccountDeniedError);
  });

  it("requireOwner refuses a member", async () => {
    const raw = createTestDb(); ensureOwnerUser(raw); invite(raw, "a@example.com");
    setIdentityResolver(async () => id());
    await expect(requireUser(raw, req())).resolves.toMatchObject({ role: "member" });
    await expect(requireOwner(raw, req())).rejects.toBeInstanceOf(OwnerOnlyError);
  });
});

describe("ensureAppUser", () => {
  it("is idempotent for an existing auth_user_id and updates last_login_at", () => {
    const raw = createTestDb(); ensureOwnerUser(raw); invite(raw, "a@example.com");
    const first = ensureAppUser(raw, id()); const second = ensureAppUser(raw, id());
    expect(second.userId).toBe(first.userId);
    expect((raw.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'a@example.com'").get() as any).n).toBe(1);
    expect((raw.prepare("SELECT last_login_at FROM users WHERE user_id = ?").get(first.userId) as any).last_login_at).not.toBeNull();
  });

  it("links a verified email to an existing row (password sign-up, then Google, then GitHub: one user_id)", () => {
    const raw = createTestDb(); invite(raw, "a@example.com");
    const viaPassword = ensureAppUser(raw, id({ authUserId: "u-pw", provider: "email" }));
    // Supabase auto-links same-email identities to ONE auth.users id, so later methods arrive with that same id
    expect(ensureAppUser(raw, id({ authUserId: "u-pw", provider: "google" })).userId).toBe(viaPassword.userId);
    expect(ensureAppUser(raw, id({ authUserId: "u-pw", provider: "github" })).userId).toBe(viaPassword.userId);
  });

  it("links a pre-existing local row (legacy user) by verified email, keeping its id and prompts", () => {
    const raw = createTestDb(); ensureOwnerUser(raw);
    raw.prepare("INSERT INTO users (display_name, email, role, status, created_at) VALUES ('Old', 'old@example.com', 'member', 'active', 'x')").run();
    const oldId = (raw.prepare("SELECT user_id FROM users WHERE email = 'old@example.com'").get() as any).user_id;
    const linked = ensureAppUser(raw, id({ email: "old@example.com", authUserId: "u-old" }));
    expect(linked.userId).toBe(oldId);
    expect(events(raw)).toContain("link");
  });

  it("an unverified email never links and never creates a row", () => {
    const raw = createTestDb(); ensureOwnerUser(raw); invite(raw, "a@example.com");
    const before = (raw.prepare("SELECT COUNT(*) AS n FROM users").get() as any).n;
    expect(() => ensureAppUser(raw, id({ emailVerified: false }))).toThrow(AccountDeniedError);
    expect(() => ensureAppUser(raw, id({ email: "owner@example.com", emailVerified: false, authUserId: "attacker" }))).toThrow(AccountDeniedError);
    expect((raw.prepare("SELECT COUNT(*) AS n FROM users").get() as any).n).toBe(before);
    expect((raw.prepare("SELECT auth_user_id FROM users WHERE role = 'owner'").get() as any).auth_user_id).toBeNull();
  });

  it("refuses an email already bound to a different identity", () => {
    const raw = createTestDb(); invite(raw, "a@example.com");
    ensureAppUser(raw, id({ authUserId: "u-1" }));
    expect(() => ensureAppUser(raw, id({ authUserId: "u-2" }))).toThrow(expect.objectContaining({ reason: "email_conflict" }));
  });

  it("creates a member from the allowlist using the supplied name; denies and logs otherwise", () => {
    const raw = createTestDb(); ensureOwnerUser(raw); invite(raw, "a@example.com");
    expect(ensureAppUser(raw, id({ displayName: "Ann Lee" }))).toMatchObject({ role: "member", displayName: "Ann Lee" });
    expect(() => ensureAppUser(raw, id({ email: "no@example.com", authUserId: "u-9" }))).toThrow(AccountDeniedError);
    expect(events(raw)).toEqual(["signup", "denied"]);
  });

  it("auth_events is append-only", () => {
    const raw = createTestDb(); invite(raw, "a@example.com"); ensureAppUser(raw, id());
    expect(() => raw.prepare("DELETE FROM auth_events").run()).toThrow(/append-only/);
    expect(() => raw.prepare("UPDATE auth_events SET event = 'login'").run()).toThrow(/append-only/);
  });
});

describe("identityFromSupabaseUser", () => {
  it("reads name from sign-up metadata, Google full_name, or GitHub user_name, and verification from the confirmation timestamp", () => {
    expect(identityFromSupabaseUser({ id: "1", email: "A@B.com", email_confirmed_at: "t", app_metadata: { provider: "email" }, user_metadata: { display_name: "Ann" } })).toMatchObject({ email: "a@b.com", displayName: "Ann", emailVerified: true, provider: "email" });
    expect(identityFromSupabaseUser({ id: "1", email: "a@b.com", email_confirmed_at: "t", app_metadata: { provider: "google" }, user_metadata: { full_name: "Ann G" } }).displayName).toBe("Ann G");
    expect(identityFromSupabaseUser({ id: "1", email: "a@b.com", email_confirmed_at: "t", app_metadata: { provider: "github" }, user_metadata: { user_name: "annhub" } }).displayName).toBe("annhub");
    expect(identityFromSupabaseUser({ id: "1", email: "a@b.com", app_metadata: {}, user_metadata: {} }).emailVerified).toBe(false);
  });
});

describe("safeNext (callback open-redirect guard)", () => {
  it.each([["https://evil.com"], ["//evil.com"], ["/\\evil.com"], ["javascript:alert(1)"], [""], [null]])("rejects %s", (n) => expect(safeNext(n as any)).toBe("/prompts"));
  it("keeps same-origin relative paths", () => { expect(safeNext("/watchlists/3?x=1")).toBe("/watchlists/3?x=1"); expect(safeNext("/reset-password")).toBe("/reset-password"); });
});

describe("sign-up form schema", () => {
  const ok = { displayName: "Ann", email: "Ann@Example.com", password: "abcdef12", confirm: "abcdef12" };
  it("accepts a valid form and normalises the email", () => { const r = signupSchema.safeParse(ok); expect(r.success && r.data.email).toBe("ann@example.com"); });
  it.each([
    [{ displayName: " " }, /name/i], [{ email: "nope" }, /email/i],
    [{ password: "abc12", confirm: "abc12" }, /8 characters/], [{ password: "abcdefgh", confirm: "abcdefgh" }, /digit/],
    [{ password: "12345678", confirm: "12345678" }, /letter/], [{ confirm: "different1" }, /match/],
  ])("rejects %j", (patch, msg) => {
    const r = signupSchema.safeParse({ ...ok, ...patch });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toMatch(msg);
  });
  it("reset schema enforces the same policy", () => { expect(resetSchema.safeParse({ password: "short1", confirm: "short1" }).success).toBe(false); });
});
