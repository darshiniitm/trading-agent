import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { runWeeklyScreen } from "@/server/weeklyScreen";

const SPEC = {
  spec_version: 4, structure: "literal" as const, timeframe: "1W" as const,
  selection_point: { session_of_week: 1, at: "open" as const },
  conditions: [{ id: "idMcap", role: "filter" as const, kind: "field" as const, name: "mcap_cr", params: {}, op: "between", value: [10000, 50000] }],
  stop: null, risk_cap_pct: null, near_miss: null,
};

function seedPromptWithTwoWatchlists(raw: ReturnType<typeof createTestDb>) {
  const ownerId = ensureOwnerUser(raw);
  const now = "2026-10-01T00:00:00.000Z";
  raw.prepare(`INSERT INTO users (user_id, display_name, role, status, created_at) VALUES (2, 'Second', 'member', 'active', ?)`).run(now);
  raw.prepare(`INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (1, ?, 'x', 'confirmed', ?, ?)`).run(ownerId, now, now);
  raw.prepare(
    `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, confirmed_at)
     VALUES (1, ?, 1, 'Prompt 1', 'x', 'literal', ?, 'h', 'confirmed', 1, 'hyp', 'kill', ?)`
  ).run(ownerId, JSON.stringify(SPEC), now);
  raw.prepare(`INSERT INTO prompt_conditions (prompt_id, cond_no, role, kind, name, op, value_origin) VALUES (1, 1, 'filter', 'field', 'mcap_cr', 'between', 'user_answer')`).run();
  raw.prepare(`INSERT INTO watchlists (watchlist_id, user_id, prompt_id, name, created_at) VALUES (1, ?, 1, 'owner wl', ?)`).run(ownerId, now);
  raw.prepare(`INSERT INTO watchlists (watchlist_id, user_id, prompt_id, name, created_at) VALUES (2, 2, 1, 'follower wl', ?)`).run(now);
  return { ownerId };
}

function fakeScreenFetch(candidates: any[]) {
  return vi.fn().mockResolvedValue({
    ok: true,
    text: async () => JSON.stringify({ candidates, applied_steps: [], funnel: [], sector_view: [] }),
  });
}

describe("runWeeklyScreen", () => {
  it("seeds a new candidate into every watchlist following the prompt", async () => {
    const raw = createTestDb();
    seedPromptWithTwoWatchlists(raw);
    const fetchFn = fakeScreenFetch([{ ticker: "FULL1", membership: "full_match", values: { idMcap: 25000 }, failed_ids: [], ep: 100, sl: 95, r: 0.05 }]);

    const { runId } = await runWeeklyScreen(raw, { promptId: 1, asOf: "2026-10-02", kind: "scheduled" }, fetchFn as any);
    expect(runId).toBeGreaterThan(0);

    const entries = raw.prepare("SELECT watchlist_id, symbol, status FROM watchlist_entries ORDER BY watchlist_id").all() as any[];
    expect(entries).toEqual([
      { watchlist_id: 1, symbol: "FULL1", status: "pending_selection" },
      { watchlist_id: 2, symbol: "FULL1", status: "pending_selection" },
    ]);
  });

  it("drops an open entry no longer present in this run's candidates, and logs the event", async () => {
    const raw = createTestDb();
    seedPromptWithTwoWatchlists(raw);
    await runWeeklyScreen(raw, { promptId: 1, asOf: "2026-10-02", kind: "scheduled" }, fakeScreenFetch([{ ticker: "FULL1", membership: "full_match", values: {}, failed_ids: [], ep: 100, sl: 95, r: 0.05 }]) as any);

    await runWeeklyScreen(raw, { promptId: 1, asOf: "2026-10-09", kind: "scheduled" }, fakeScreenFetch([]) as any);

    const entry = raw.prepare("SELECT status FROM watchlist_entries WHERE watchlist_id = 1 AND symbol = 'FULL1'").get() as any;
    expect(entry.status).toBe("dropped_from_screen");
    const events = raw.prepare("SELECT type, to_value FROM entry_events").all() as any[];
    expect(events.some((e) => e.type === "dropped_from_screen" && e.to_value === "dropped_from_screen")).toBe(true);
  });

  it("updates an existing open entry's membership (near_miss -> full_match) instead of creating a duplicate", async () => {
    const raw = createTestDb();
    seedPromptWithTwoWatchlists(raw);
    await runWeeklyScreen(raw, { promptId: 1, asOf: "2026-10-02", kind: "scheduled" }, fakeScreenFetch([{ ticker: "X", membership: "near_miss", values: {}, failed_ids: ["idMcap"], ep: 10, sl: null, r: null }]) as any);

    await runWeeklyScreen(raw, { promptId: 1, asOf: "2026-10-09", kind: "scheduled" }, fakeScreenFetch([{ ticker: "X", membership: "full_match", values: {}, failed_ids: [], ep: 11, sl: 10, r: 0.1 }]) as any);

    const rows = raw.prepare("SELECT membership FROM watchlist_entries WHERE watchlist_id = 1 AND symbol = 'X'").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].membership).toBe("full_match");
  });

  it("handles zero candidates and zero watchlists without crashing", async () => {
    const raw = createTestDb();
    const ownerId = ensureOwnerUser(raw);
    const now = new Date().toISOString();
    raw.prepare(`INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (1, ?, 'x', 'confirmed', ?, ?)`).run(ownerId, now, now);
    raw.prepare(
      `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, confirmed_at)
       VALUES (1, ?, 1, 'Prompt 1', 'x', 'literal', ?, 'h', 'confirmed', 1, 'hyp', 'kill', ?)`
    ).run(ownerId, JSON.stringify(SPEC), now);
    const { runId } = await runWeeklyScreen(raw, { promptId: 1, asOf: "2026-10-02", kind: "scheduled" }, fakeScreenFetch([]) as any);
    expect(runId).toBeGreaterThan(0);
  });
});
