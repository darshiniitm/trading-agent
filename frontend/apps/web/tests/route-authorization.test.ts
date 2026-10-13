import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { setIdentityResolver } from "@/server/auth/requireUser";
import { program } from "./helpers/program";

let raw = createTestDb();
vi.mock("@/server/db/client", () => ({ db: () => raw }));
vi.mock("@/server/engine/client", async (orig) => ({ ...(await orig<any>()), startPrefetch: vi.fn(async () => ({ started: true })), getDataHealth: vi.fn(async () => ({ ok: true })), getHealth: vi.fn(async () => ({})) }));
vi.mock("@/server/engine/supervisor", () => ({ getSupervisor: () => ({ retry: async () => {}, beat: () => {}, status: async () => ({ state: "ready" }), recentLog: () => "" }) }));

import { GET as getDraft, PATCH as patchDraft } from "@/../app/api/drafts/[draftId]/route";
import { POST as confirmRoute } from "@/../app/api/drafts/[draftId]/confirm/route";
import { POST as compileRoute } from "@/../app/api/drafts/[draftId]/program/route";
import { POST as retire } from "@/../app/api/prompts/[promptId]/retire/route";
import { POST as editRoute } from "@/../app/api/prompts/[promptId]/edit/route";
import { PATCH as visibility } from "@/../app/api/prompts/[promptId]/visibility/route";
import { POST as follow } from "@/../app/api/prompts/[promptId]/follow/route";
import { POST as copy } from "@/../app/api/prompts/[promptId]/copy/route";
import { GET as getWatchlist } from "@/../app/api/watchlists/[watchlistId]/route";
import { GET as getEntry, DELETE as delEntry } from "@/../app/api/watchlists/[watchlistId]/entries/[entryId]/route";
import { POST as prefetch } from "@/../app/api/data/prefetch/route";
import { POST as engineRetry } from "@/../app/api/engine/retry/route";
import { GET as dataHealth } from "@/../app/api/data/health/route";
import { GET as engineStatus } from "@/../app/api/engine/status/route";
import { POST as quotes } from "@/../app/api/quotes/route";
import { POST as closes } from "@/../app/api/series/closes/route";
import { GET as listPrompts } from "@/../app/api/prompts/route";
import { GET as explore } from "@/../app/api/explore/route";
import { GET as settings } from "@/../app/api/settings/defaults/route";
import { POST as createDraft } from "@/../app/api/drafts/route";
import { GET as healthRoute } from "@/../app/api/health/route";

const OWNER = { authUserId: "test-owner-uuid", email: "owner@example.com", emailVerified: true, displayName: "Owner", provider: "email" };
const OTHER = { authUserId: "u-other", email: "other@example.com", emailVerified: true, displayName: "Other", provider: "google" };
const as = (who: typeof OWNER | null) => setIdentityResolver(async () => who);
const r = (method = "GET", body?: unknown) => new Request("http://localhost/x", { method, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = (p: any) => ({ params: p });

function world() {
  raw = createTestDb();
  const owner = ensureOwnerUser(raw);
  raw.prepare("INSERT INTO signup_allowlist (email, created_at) VALUES ('other@example.com', 'x')").run();
  const now = new Date().toISOString();
  const spec = JSON.stringify(program());
  const mk = (id: number, visibilityValue: "private" | "shared") => {
    raw.prepare("INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (?, ?, 'x', 'confirmed', ?, ?)").run(id, owner, now, now);
    raw.prepare("INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, visibility, confirmed_at) VALUES (?, ?, ?, 'T', 'x', 'literal', ?, ?, 'confirmed', 1, 'h', 'k', ?, ?)").run(id, owner, id, spec, `h${id}`, visibilityValue, now);
    raw.prepare("INSERT INTO watchlists (watchlist_id, user_id, prompt_id, name, created_at) VALUES (?, ?, ?, 'W', ?)").run(id, owner, id, now);
    raw.prepare("INSERT OR IGNORE INTO symbols (symbol, active) VALUES ('AAA', 1)").run();
    raw.prepare("INSERT INTO runs (run_id, prompt_id, as_of, kind, status) VALUES (?, ?, '2026-01-01', 'scheduled', 'done')").run(id, id);
    raw.prepare("INSERT INTO watchlist_entries (entry_id, watchlist_id, symbol, first_run_id, last_run_id, membership, status, created_at, updated_at) VALUES (?, ?, 'AAA', ?, ?, 'full_match', 'pending_selection', ?, ?)").run(id, id, id, id, now, now);
  };
  mk(10, "private"); mk(11, "shared");
  raw.prepare("INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (20, ?, 'draft', 'open', ?, ?)").run(owner, now, now);
  return owner;
}
afterEach(() => as(OWNER));

describe("anonymous requests", () => {
  it("get 401 from every protected route (health stays public)", async () => {
    world(); as(null);
    const calls: [string, Promise<Response>][] = [
      ["createDraft", createDraft(r("POST"))], ["getDraft", getDraft(r(), ctx({ draftId: "20" }))], ["patchDraft", patchDraft(r("PATCH", {}), ctx({ draftId: "20" }))],
      ["confirm", confirmRoute(r("POST", { as_of: "2026-01-01" }), ctx({ draftId: "20" }))], ["compile", compileRoute(r("POST"), ctx({ draftId: "20" }))],
      ["retire", retire(r("POST"), ctx({ promptId: "10" }))], ["edit", editRoute(r("POST"), ctx({ promptId: "10" }))], ["visibility", visibility(r("PATCH", { visibility: "shared" }), ctx({ promptId: "10" }))],
      ["follow", follow(r("POST"), ctx({ promptId: "11" }))], ["copy", copy(r("POST"), ctx({ promptId: "11" }))],
      ["watchlist", getWatchlist(r(), ctx({ watchlistId: "11" }))], ["entry", getEntry(r(), ctx({ watchlistId: "11", entryId: "11" }))], ["delEntry", delEntry(r("DELETE"), ctx({ watchlistId: "10", entryId: "10" }))],
      ["prefetch", prefetch(r("POST"))], ["engineRetry", engineRetry(r("POST"))], ["dataHealth", dataHealth(r())], ["engineStatus", engineStatus(r())],
      ["quotes", quotes(r("POST", { symbols: ["AAA"] }))], ["closes", closes(r("POST", { symbols: ["AAA"] }))],
      ["listPrompts", listPrompts(r())], ["explore", explore(r())], ["settings", settings(r())],
    ];
    for (const [name, p] of calls) expect({ name, status: (await p).status }).toEqual({ name, status: 401 });
    expect((await healthRoute()).status).not.toBe(401);
  });
});

describe("another signed-in user", () => {
  it("cannot read or touch the owner's drafts (404, not 403)", async () => {
    world(); as(OTHER);
    expect((await getDraft(r(), ctx({ draftId: "20" }))).status).toBe(404);
    expect((await patchDraft(r("PATCH", { title: "x" }), ctx({ draftId: "20" }))).status).toBe(404);
    expect((await confirmRoute(r("POST", { as_of: "2026-01-01" }), ctx({ draftId: "20" }))).status).toBe(404);
    expect((await compileRoute(r("POST"), ctx({ draftId: "20" }))).status).toBe(404);
    expect(raw.prepare("SELECT title FROM prompt_drafts WHERE draft_id = 20").get()).toMatchObject({ title: null });
  });

  it("cannot retire, edit or re-share the owner's prompts; a private prompt looks missing", async () => {
    world(); as(OTHER);
    for (const id of ["10", "11"]) {
      expect((await retire(r("POST"), ctx({ promptId: id }))).status).toBe(404);
      expect((await editRoute(r("POST"), ctx({ promptId: id }))).status).toBe(404);
    }
    expect((await visibility(r("PATCH", { visibility: "private" }), ctx({ promptId: "11" }))).status).toBe(404);
    expect((await follow(r("POST"), ctx({ promptId: "10" }))).status).toBe(404);
    expect((await copy(r("POST"), ctx({ promptId: "10" }))).status).toBe(404);
    expect(raw.prepare("SELECT status, visibility FROM prompts WHERE prompt_id = 11").get()).toMatchObject({ status: "confirmed", visibility: "shared" });
  });

  it("can read a shared prompt's watchlist (read-only) but not a private one, and cannot delete entries", async () => {
    world(); as(OTHER);
    expect((await getWatchlist(r(), ctx({ watchlistId: "11" }))).status).toBe(200);
    expect((await getWatchlist(r(), ctx({ watchlistId: "10" }))).status).toBe(404);
    expect((await getEntry(r(), ctx({ watchlistId: "11", entryId: "11" }))).status).toBe(200);
    expect((await getEntry(r(), ctx({ watchlistId: "10", entryId: "10" }))).status).toBe(404);
    expect((await getEntry(r(), ctx({ watchlistId: "11", entryId: "10" }))).status).toBe(404);   // entry from another list
    expect((await delEntry(r("DELETE"), ctx({ watchlistId: "11", entryId: "11" }))).status).toBe(404);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM watchlist_entries").get()).toMatchObject({ n: 2 });
  });

  it("can follow and copy a shared prompt, and use the signed-in-only utilities", async () => {
    world(); as(OTHER);
    expect((await follow(r("POST"), ctx({ promptId: "11" }))).status).toBe(201);
    expect((await copy(r("POST"), ctx({ promptId: "11" }))).status).toBe(201);
    expect((await engineStatus(r())).status).toBe(200);
    expect((await quotes(r("POST", { symbols: [] }))).status).not.toBe(401);
  });

  it("is refused by the owner-only engine and data routes (403)", async () => {
    world(); as(OTHER);
    for (const p of [prefetch(r("POST")), engineRetry(r("POST")), dataHealth(r())]) expect((await p).status).toBe(403);
  });

  it("an uninvited Google account is refused with 403 not_invited", async () => {
    world(); as({ ...OTHER, authUserId: "u-x", email: "stranger@example.com" });
    const res = await listPrompts(r());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: "not_invited" });
  });
});

describe("owner", () => {
  it("passes ownership checks and reaches owner-only routes", async () => {
    world(); as(OWNER);
    expect((await getDraft(r(), ctx({ draftId: "20" }))).status).toBe(200);
    expect((await retire(r("POST"), ctx({ promptId: "10" }))).status).not.toBe(404);
    expect((await prefetch(r("POST"))).status).toBe(200);
    expect((await dataHealth(r())).status).toBe(200);
    expect((await getWatchlist(r(), ctx({ watchlistId: "10" }))).status).toBe(200);
  });
});
