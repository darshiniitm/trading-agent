import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { setIdentityResolver } from "@/server/auth/requireUser";
import { ensureOwnerUser } from "@/server/db/seed";

let raw = createTestDb();
vi.mock("@/server/db/client", () => ({ db: () => raw }));
const status = (o: any = {}) => ({ state: "idle", done: 0, total: 0, started_at: null, finished_at: null, error: null, last_refreshed: { fetched_at: "2026-10-15T06:09:00+00:00", latest_bar_date: "2026-10-12" }, ...o });
const beat = vi.fn();
vi.mock("@/server/engine/supervisor", () => ({ getSupervisor: () => ({ beat, status: async () => ({ state: "ready" }), retry: async () => {}, recentLog: () => "" }) }));
vi.mock("@/server/engine/client", async (orig) => ({
  ...(await orig<any>()),
  getRefreshStatus: vi.fn(async () => status()),
  startRefresh: vi.fn(async () => status({ state: "running", started: true })),
  getDataHealth: vi.fn(async () => ({ stale_symbols: 0 })),
  startPrefetch: vi.fn(async () => ({ started: true })),
}));
import { GET as getRefresh, POST as postRefresh } from "@/../app/api/data/refresh/route";
import { GET as getHealth } from "@/../app/api/data/health/route";
import { POST as postPrefetch } from "@/../app/api/data/prefetch/route";

const OWNER = { authUserId: "test-owner-uuid", email: "owner@example.com", emailVerified: true, displayName: "Owner", provider: "email" };
const OTHER = { authUserId: "u-other", email: "other@example.com", emailVerified: true, displayName: "Other", provider: "google" };
const as = (who: typeof OWNER | null) => setIdentityResolver(async () => who);
const r = (method = "GET") => new Request("http://localhost/x", { method });

beforeEach(() => { raw = createTestDb(); ensureOwnerUser(raw); raw.prepare("INSERT INTO signup_allowlist (email, created_at) VALUES ('other@example.com', 'x')").run(); beat.mockClear(); as(OWNER); });
afterEach(() => as(OWNER));

describe("/api/data/refresh", () => {
  it("any signed-in user sees when the data was last refreshed", async () => {
    as(OTHER);
    const res = await getRefresh(r());
    expect(res.status).toBe(200);
    expect((await res.json()).last_refreshed.latest_bar_date).toBe("2026-10-12");
    expect(beat).toHaveBeenCalled();
  });

  it("only the owner may start a refresh", async () => {
    as(OTHER);
    expect((await postRefresh(r("POST"))).status).toBe(403);
    as(null);
    expect((await postRefresh(r("POST"))).status).toBe(401);
    as(OWNER);
    const res = await postRefresh(r("POST"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "running", started: true });
  });

  it("reports an unreachable engine as 502 instead of throwing", async () => {
    const client = await import("@/server/engine/client");
    (client.getRefreshStatus as any).mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    expect((await getRefresh(r())).status).toBe(502);
  });
});

describe("/api/data/health and /api/data/prefetch (the Data health page's routes)", () => {
  it("are owner-only and reach the engine", async () => {
    as(OTHER);
    expect((await getHealth(r())).status).toBe(403);
    expect((await postPrefetch(r("POST"))).status).toBe(403);
    as(OWNER);
    expect((await getHealth(r())).status).toBe(200);
    expect((await postPrefetch(r("POST"))).status).toBe(200);
  });
});
