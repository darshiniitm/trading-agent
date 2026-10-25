import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { seedUiDemo } from "@/server/db/seed";
import { setIdentityResolver } from "@/server/auth/requireUser";
import { _resetQuoteCacheForTests } from "@/server/quotes";
import { resetRateLimits } from "@/server/rateLimit";

let raw = await createTestDb();
vi.mock("@/server/db/client", () => ({ db: () => raw }));

const METRIC = { as_of: "2026-10-14", timeframe: "1D", rsi14: 60, tech_rating: 0.35, ma_rating: 0.6, os_rating: 0.1, beta_benchmark: "^NSEI", votes: {} };
vi.mock("@/server/engine/client", async (orig) => ({
  ...(await orig<any>()),
  postQuotes: vi.fn(async (symbols: string[]) => Object.fromEntries(symbols.map((s) => [s, s === "USDINR=X"
    ? { price: 80, source: "yahoo", source_ts: "2026-10-15T09:30:00+00:00" }
    : { price: 120, source: "yahoo", source_ts: "2026-10-15T09:30:00+00:00", prev_close: 100, volume: 5000 }]))),
  getMetrics: vi.fn(async (symbols: string[], tf: string) => Object.fromEntries(symbols.map((s) => [s, { ...METRIC, timeframe: tf }]))),
  getHistory: vi.fn(async (symbol: string) => ({ symbol, dates: ["2026-10-09"], closes: [1, 2, 3] })),
  getFundamentals: vi.fn(async (symbols: string[]) => Object.fromEntries(symbols.map((s) => [s, { currency: "INR", market_cap: 1e11, shares_out: 1e9, revenue_ttm: 5e10, eps_ttm: 10, dividend_ttm: 2 }]))),
}));

import { GET as getViews, POST as refreshViews } from "@/../app/api/watchlists/[watchlistId]/views/route";
import { PATCH as patchPrefs } from "@/../app/api/watchlists/[watchlistId]/view-prefs/route";
import { GET as getBench, PUT as putBench } from "@/../app/api/me/benchmarks/route";
import { GET as getHistoryRoute } from "@/../app/api/series/history/route";
import { prep } from "./helpers/prep";

const OWNER = { authUserId: "00000000-0000-4000-8000-1fd6d1071c77", email: "owner@example.com", emailVerified: true, displayName: "Owner", provider: "email" };
const as = (who: typeof OWNER | null) => setIdentityResolver(async () => who);
const ctx = (id: number | string) => ({ params: { watchlistId: String(id) } });
const req = (url = "http://localhost/x", method = "GET", body?: unknown) => new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(async () => { raw = await createTestDb(); await seedUiDemo(raw); _resetQuoteCacheForTests(); resetRateLimits(); as(OWNER); });
afterEach(async () => as(OWNER));

describe("GET /api/watchlists/:id/views", () => {
  it("returns every view group, sections, as-of dates, fx (INR->USD divides) and prefs in one call", async () => {
    const res = await getViews(req("http://localhost/x?tf=1D"), ctx(1));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sections.map((s: any) => s.id)).toEqual(["benchmarks", "picks", "watching"]);
    expect(body.fx).toEqual({ inrPerUsd: 80, usdPerInr: 0.0125, asOf: "2026-10-15T09:30:00+00:00" });
    expect(body.prefs).toMatchObject({ view: "screen", currency: "INR", techTimeframe: "1D" });
    const aaa = body.sections[1].rows.find((r: any) => r.symbol === "AAA.NS");
    expect(aaa.price).toMatchObject({ last: 120, chg: 20, chgPct: 20, volume: 5000 });
    expect(Object.keys(aaa)).toEqual(expect.arrayContaining(["price", "financials", "performance", "risk", "technicals"]));
    expect(body.asOf.quotes).toBe("2026-10-15T09:30:00+00:00");
  });

  it("serves rows as computing at first and computes the missing metrics in the background", async () => {
    const first = await (await getViews(req(), ctx(1))).json();
    expect(first.missingSymbols.length).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 30));
    const second = await (await getViews(req(), ctx(1))).json();
    expect(second.missingSymbols).toEqual([]);
    expect(second.sections[1].rows[0].technicals.techLabel).toBe("Buy");
  });

  it("still answers when the engine's quotes are down", async () => {
    const client = await import("@/server/engine/client");
    (client.postQuotes as any).mockRejectedValueOnce(new Error("engine down"));
    const res = await getViews(req(), ctx(1));
    expect(res.status).toBe(200);
    expect((await res.json()).sections[1].rows[0].price.last).toBeNull();
  });

  it("rejects a bad timeframe, an unknown watchlist and anonymous callers", async () => {
    expect((await getViews(req("http://localhost/x?tf=1M"), ctx(1))).status).toBe(400);
    expect((await getViews(req(), ctx(999))).status).toBe(404);
    as(null);
    expect((await getViews(req(), ctx(1))).status).toBe(401);
  });

  it("hides another user's private watchlist (404, never 403)", async () => {
    await prep(raw, "INSERT INTO signup_allowlist (email, created_at) VALUES ('other@example.com', now())").run();
    as({ authUserId: "00000000-0000-4000-8000-8e1868009208", email: "other@example.com", emailVerified: true, displayName: "O", provider: "google" });
    // watchlist 1 belongs to the owner; prompt 12 is shared in the demo seed, so use the private prompt 9's watchlist
    await prep(raw, "INSERT INTO watchlists (watchlist_id, user_id, prompt_id, name, created_at) VALUES (50, 1, 9, 'W', now())").run();
    expect((await getViews(req(), ctx(50))).status).toBe(404);
  });
});

describe("background metric computation", () => {
  it("is not started twice for the same symbols while the first run is still in flight", async () => {
    const client = await import("@/server/engine/client");
    const getMetrics = client.getMetrics as any;
    getMetrics.mockClear();
    let release!: () => void;
    getMetrics.mockImplementationOnce(async (symbols: string[], tf: string) => { await new Promise<void>((r) => { release = r; }); return Object.fromEntries(symbols.map((s) => [s, { ...METRIC, timeframe: tf }])); });
    await getViews(req(), ctx(1));
    await getViews(req(), ctx(1));
    await getViews(req(), ctx(1));
    expect(getMetrics).toHaveBeenCalledTimes(1);
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(((await (await getViews(req(), ctx(1))).json()) as any).missingSymbols).toEqual([]);
  });
});

describe("POST /api/watchlists/:id/views (Refresh metrics)", () => {
  it("recomputes now and returns the fresh payload with nothing left computing", async () => {
    const body = await (await refreshViews(req("http://localhost/x?tf=1D", "POST"), ctx(1))).json();
    expect(body.missingSymbols).toEqual([]);
    expect(body.asOf.metrics).toBe("2026-10-14");
  });
});

describe("PATCH /api/watchlists/:id/view-prefs", () => {
  it("saves the last view, currency and hidden columns and returns them", async () => {
    const res = await patchPrefs(req("http://localhost/x", "PATCH", { view: "technicals", currency: "USD", hiddenColumns: { technicals: ["cci"] } }), ctx(1));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ view: "technicals", currency: "USD", hiddenColumns: { technicals: ["cci"] } });
    const after = await (await getViews(req(), ctx(1))).json();
    expect(after.prefs.view).toBe("technicals");
  });

  it("400s on an unknown view and 404s on an invisible watchlist", async () => {
    expect((await patchPrefs(req("http://localhost/x", "PATCH", { view: "nope" }), ctx(1))).status).toBe(400);
    expect((await patchPrefs(req("http://localhost/x", "PATCH", { view: "risk" }), ctx(999))).status).toBe(404);
  });
});

describe("/api/me/benchmarks", () => {
  it("defaults, then stores the user's own list; rejects stocks", async () => {
    expect((await (await getBench(req())).json()).symbols).toEqual(["^NSEI", "^NSEBANK", "^BSESN", "^CNXIT", "^GSPC"]);
    expect((await (await putBench(req("http://localhost/x", "PUT", { symbols: ["^NSEI", "^GSPC"] }))).json()).symbols).toEqual(["^NSEI", "^GSPC"]);
    expect((await (await getBench(req())).json()).symbols).toEqual(["^NSEI", "^GSPC"]);
    expect((await putBench(req("http://localhost/x", "PUT", { symbols: ["AAA.NS"] }))).status).toBe(400);
    expect((await putBench(req("http://localhost/x", "PUT", { symbols: "x" }))).status).toBe(400);
  });
});

describe("GET /api/series/history", () => {
  it("serves weekly closes for an index symbol only — never an open proxy for arbitrary tickers", async () => {
    expect((await getHistoryRoute(req("http://localhost/x?symbol=%5ENSEI"))).status).toBe(200);
    expect((await getHistoryRoute(req("http://localhost/x?symbol=AAA.NS"))).status).toBe(404);
    expect((await getHistoryRoute(req("http://localhost/x?symbol=%5EUNKNOWN"))).status).toBe(404);
    as(null);
    expect((await getHistoryRoute(req("http://localhost/x?symbol=%5ENSEI"))).status).toBe(401);
  });
});
