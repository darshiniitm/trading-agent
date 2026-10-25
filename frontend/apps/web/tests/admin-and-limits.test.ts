import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { setIdentityResolver } from "@/server/auth/requireUser";
import { rateLimited, resetRateLimits, LIMITS } from "@/server/rateLimit";

let raw = await createTestDb();
vi.mock("@/server/db/client", () => ({ db: () => raw }));
import { GET, POST, DELETE, PATCH } from "@/../app/api/admin/allowlist/route";
import { PATCH as profile } from "@/../app/api/auth/profile/route";
import { prep } from "./helpers/prep";

const OWNER = { authUserId: "00000000-0000-4000-8000-1fd6d1071c77", email: "owner@example.com", emailVerified: true, displayName: "Owner", provider: "email" };
const MEMBER = { authUserId: "00000000-0000-4000-8000-641bc7576c7d", email: "m@example.com", emailVerified: true, displayName: "M", provider: "google" };
const req = (method: string, body?: unknown) => new Request("http://x", { method, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(async () => { raw = await createTestDb(); await ensureOwnerUser(raw); resetRateLimits(); setIdentityResolver(async () => OWNER); });
afterEach(async () => setIdentityResolver(async () => OWNER));

describe("allowlist admin (owner only)", () => {
  it("owner invites, lists and removes; the invitee can then sign up as a member", async () => {
    expect((await POST(req("POST", { email: "M@Example.com" }))).status).toBe(201);
    const list = await (await GET(req("GET"))).json();
    expect(list.allowlist.map((a: any) => a.email)).toContain("m@example.com");
    setIdentityResolver(async () => MEMBER);
    expect((await profile(req("PATCH", { displayName: "Mia" }))).status).toBe(200);
    expect(await prep(raw, "SELECT display_name FROM users WHERE email = 'm@example.com'").get()).toMatchObject({ display_name: "Mia" });
    setIdentityResolver(async () => OWNER);
    expect((await DELETE(req("DELETE", { email: "m@example.com" }))).status).toBe(200);
  });

  it("a member gets 403 on every verb; the owner can't remove their own email or disable themselves", async () => {
    await POST(req("POST", { email: "m@example.com" }));
    setIdentityResolver(async () => MEMBER);
    for (const r of [GET(req("GET")), POST(req("POST", { email: "x@y.com" })), DELETE(req("DELETE", { email: "m@example.com" })), PATCH(req("PATCH", { userId: 1, status: "disabled" }))]) expect((await r).status).toBe(403);
    setIdentityResolver(async () => OWNER);
    expect((await DELETE(req("DELETE", { email: "owner@example.com" }))).status).toBe(400);
    expect((await PATCH(req("PATCH", { userId: 1, status: "disabled" }))).status).toBe(400);
  });

  it("disabling a member locks them out", async () => {
    await POST(req("POST", { email: "m@example.com" }));
    setIdentityResolver(async () => MEMBER); await profile(req("PATCH", { displayName: "M" }));
    const id = (await prep(raw, "SELECT user_id FROM users WHERE email = 'm@example.com'").get() as any).user_id;
    setIdentityResolver(async () => OWNER);
    expect((await PATCH(req("PATCH", { userId: id, status: "disabled" }))).status).toBe(200);
    setIdentityResolver(async () => MEMBER);
    expect((await profile(req("PATCH", { displayName: "again" }))).status).toBe(403);
  });
});

describe("rate limiter", () => {
  it("blocks past the limit per user and bucket, then recovers after the window", async () => {
    const t0 = 1_000_000;
    for (let i = 0; i < LIMITS.model.max; i++) expect(rateLimited(1, "model", t0)).toBeNull();
    const blocked = rateLimited(1, "model", t0 + 1);
    expect(blocked?.status).toBe(429);
    expect(blocked?.headers.get("retry-after")).toBeTruthy();
    expect(rateLimited(2, "model", t0 + 1)).toBeNull();      // other user unaffected
    expect(rateLimited(1, "data", t0 + 1)).toBeNull();       // other bucket unaffected
    expect(rateLimited(1, "model", t0 + LIMITS.model.windowMs + 1)).toBeNull();
  });
});
