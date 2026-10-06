import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { runSelectEntry } from "@/server/selectEntry";
import { runWeeklyScreen } from "@/server/weeklyScreen";

const SPEC = {
  spec_version: 4, structure: "literal" as const, timeframe: "1W" as const,
  selection_point: { session_of_week: 1, at: "open" as const },
  conditions: [], stop: null, risk_cap_pct: null, near_miss: null,
};

function seedRunAndEntries(raw: ReturnType<typeof createTestDb>, rows: { symbol: string; membership: string; status: string }[]) {
  const ownerId = ensureOwnerUser(raw);
  const now = new Date().toISOString();
  raw.prepare(`INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (1, ?, 'x', 'confirmed', ?, ?)`).run(ownerId, now, now);
  raw.prepare(
    `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, confirmed_at)
     VALUES (1, ?, 1, 'Prompt 1', 'x', 'literal', ?, 'h', 'confirmed', 1, 'hyp', 'kill', ?)`
  ).run(ownerId, JSON.stringify(SPEC), now);
  raw.prepare(`INSERT INTO watchlists (watchlist_id, user_id, prompt_id, name, created_at) VALUES (1, ?, 1, 'wl', ?)`).run(ownerId, now);
  const runInfo = raw.prepare(`INSERT INTO runs (prompt_id, as_of, kind, status, finished_at) VALUES (1, '2026-10-02', 'scheduled', 'done', ?)`).run(now);
  const runId = Number(runInfo.lastInsertRowid);
  for (const row of rows) {
    raw.prepare(`INSERT OR IGNORE INTO symbols (symbol, active) VALUES (?, 1)`).run(row.symbol);
    raw.prepare(
      `INSERT INTO run_results (run_id, symbol, membership, in_forward_record, cond_json, entry_status) VALUES (?, ?, ?, 0, '{}', ?)`
    ).run(runId, row.symbol, row.membership, row.status);
    raw.prepare(
      `INSERT INTO watchlist_entries (watchlist_id, symbol, first_run_id, last_run_id, membership, status, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)`
    ).run(row.symbol, runId, runId, row.membership, row.status, now, now);
  }
  return { runId };
}

function fakeSelectFetch(body: unknown) {
  return vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify(body) });
}

describe("runSelectEntry", () => {
  it("marks a full_match pick entered with its entry_price and stop", async () => {
    const raw = createTestDb();
    const { runId } = seedRunAndEntries(raw, [{ symbol: "FULL1", membership: "full_match", status: "pending_selection" }]);
    const fetchFn = fakeSelectFetch({ entered: [{ ticker: "FULL1", membership: "full_match", values: {}, failed_ids: [], ep: 100, sl: 95, r: 0.05, entry_price: 101 }], not_confirmed: [], no_point_data: [], watching: [] });

    await runSelectEntry(raw, { promptId: 1, runId }, fetchFn as any);

    const entry = raw.prepare("SELECT status, entry_price, stop FROM watchlist_entries WHERE symbol = 'FULL1'").get() as any;
    expect(entry).toEqual({ status: "entered", entry_price: 101, stop: 95 });
    const result = raw.prepare("SELECT entry_status FROM run_results WHERE symbol = 'FULL1'").get() as any;
    expect(result.entry_status).toBe("entered");
    const events = raw.prepare("SELECT type, from_value, to_value FROM entry_events").all() as any[];
    expect(events).toEqual([{ type: "status_changed", from_value: "pending_selection", to_value: "entered" }]);
  });

  it("marks a shadow candidate watching with a ref_price, never writing entry_price (D8)", async () => {
    const raw = createTestDb();
    const { runId } = seedRunAndEntries(raw, [{ symbol: "NEAR1", membership: "near_miss", status: "watching" }]);
    const fetchFn = fakeSelectFetch({ entered: [], not_confirmed: [], no_point_data: [], watching: [{ ticker: "NEAR1", membership: "near_miss", values: {}, failed_ids: ["C1"], ep: 50, sl: null, r: null, ref_price: 51.5 }] });

    await runSelectEntry(raw, { promptId: 1, runId }, fetchFn as any);

    const entry = raw.prepare("SELECT status, entry_price, ref_price FROM watchlist_entries WHERE symbol = 'NEAR1'").get() as any;
    expect(entry).toEqual({ status: "watching", entry_price: null, ref_price: 51.5 });
  });

  it("handles a run where every candidate ends up watching, with no entered/not_confirmed/no_point_data at all", async () => {
    const raw = createTestDb();
    const { runId } = seedRunAndEntries(raw, [{ symbol: "NEAR1", membership: "near_miss", status: "watching" }]);
    const fetchFn = fakeSelectFetch({ entered: [], not_confirmed: [], no_point_data: [], watching: [{ ticker: "NEAR1", membership: "near_miss", values: {}, failed_ids: [], ep: 50, sl: null, r: null, ref_price: 51 }] });

    const { updated } = await runSelectEntry(raw, { promptId: 1, runId }, fetchFn as any);
    expect(updated).toBe(1);
    const count = raw.prepare("SELECT COUNT(*) AS n FROM run_results WHERE entry_status = 'entered'").get() as any;
    expect(count.n).toBe(0);
  });

  // Since the final-review freeze fix this seeds an already-'entered' entry,
  // which runSelectEntry now skips entirely (frozen) — the zero-events
  // assertion still holds, but now as a consequence of the freeze. The
  // original "unchanged status logs nothing" meaning for a non-frozen entry
  // is covered by the next test.
  it("does not log an event when status is unchanged", async () => {
    const raw = createTestDb();
    const { runId } = seedRunAndEntries(raw, [{ symbol: "FULL1", membership: "full_match", status: "entered" }]);
    const fetchFn = fakeSelectFetch({ entered: [{ ticker: "FULL1", membership: "full_match", values: {}, failed_ids: [], ep: 100, sl: 95, r: 0.05, entry_price: 101 }], not_confirmed: [], no_point_data: [], watching: [] });
    await runSelectEntry(raw, { promptId: 1, runId }, fetchFn as any);
    const events = raw.prepare("SELECT COUNT(*) AS n FROM entry_events").get() as any;
    expect(events.n).toBe(0);
  });

  it("does not log an event when a non-frozen entry's status is unchanged (watching -> watching)", async () => {
    const raw = createTestDb();
    const { runId } = seedRunAndEntries(raw, [{ symbol: "NEAR1", membership: "near_miss", status: "watching" }]);
    const fetchFn = fakeSelectFetch({ entered: [], not_confirmed: [], no_point_data: [], watching: [{ ticker: "NEAR1", membership: "near_miss", values: {}, failed_ids: [], ep: 50, sl: null, r: null, ref_price: 52 }] });
    await runSelectEntry(raw, { promptId: 1, runId }, fetchFn as any);
    expect(raw.prepare("SELECT ref_price FROM watchlist_entries WHERE symbol = 'NEAR1'").get()).toEqual({ ref_price: 52 });
    expect((raw.prepare("SELECT COUNT(*) AS n FROM entry_events").get() as any).n).toBe(0);
  });

  // --- Freeze regression (final-review C2): an entered pick's price, stop and
  // entry date are a historical fact — no later /select may rewrite them.

  const SCREEN_SPEC = { ...SPEC, conditions: [{ id: "idMcap", role: "filter", kind: "field", name: "mcap_cr", params: {}, op: "between", value: [10000, 50000] }] };

  function seedPromptOnly(raw: ReturnType<typeof createTestDb>) {
    const ownerId = ensureOwnerUser(raw);
    const now = new Date().toISOString();
    raw.prepare(`INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (1, ?, 'x', 'confirmed', ?, ?)`).run(ownerId, now, now);
    raw.prepare(
      `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, confirmed_at)
       VALUES (1, ?, 1, 'Prompt 1', 'x', 'literal', ?, 'h', 'confirmed', 1, 'hyp', 'kill', ?)`
    ).run(ownerId, JSON.stringify(SCREEN_SPEC), now);
    raw.prepare(`INSERT INTO prompt_conditions (prompt_id, cond_no, role, kind, name, op, value_origin) VALUES (1, 1, 'filter', 'field', 'mcap_cr', 'between', 'user_answer')`).run();
    raw.prepare(`INSERT INTO watchlists (watchlist_id, user_id, prompt_id, name, created_at) VALUES (1, ?, 1, 'wl', ?)`).run(ownerId, now);
  }

  // Routes /screen and /select; FULL1 is a full_match every week, and /select
  // enters it at the given price.
  function weekFetch(entryPrice: number, sl: number) {
    return vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/screen")) {
        return { ok: true, text: async () => JSON.stringify({ candidates: [{ ticker: "FULL1", membership: "full_match", values: {}, failed_ids: [], ep: entryPrice, sl, r: 0.05 }], applied_steps: [], funnel: [], sector_view: [] }) };
      }
      if (url.endsWith("/select")) {
        return { ok: true, text: async () => JSON.stringify({ entered: [{ ticker: "FULL1", membership: "full_match", values: {}, failed_ids: [], ep: entryPrice, sl, r: 0.05, entry_price: entryPrice }], not_confirmed: [], no_point_data: [], watching: [] }) };
      }
      throw new Error(`unexpected url ${url}`);
    });
  }

  it("never rewrites an entered entry's entry_price/stop/entry_date when next week's /select enters it again at a different price", async () => {
    const raw = createTestDb();
    seedPromptOnly(raw);
    const { runId: r1 } = await runWeeklyScreen(raw, { promptId: 1, asOf: "2026-10-02", kind: "scheduled" }, weekFetch(101, 95) as any);
    await runSelectEntry(raw, { promptId: 1, runId: r1 }, weekFetch(101, 95) as any);
    const original = raw.prepare("SELECT entry_id, status, entry_price, stop, entry_date, last_run_id FROM watchlist_entries WHERE symbol = 'FULL1'").get() as any;
    expect(original).toMatchObject({ status: "entered", entry_price: 101, stop: 95, entry_date: "2026-10-02", last_run_id: r1 });

    const { runId: r2 } = await runWeeklyScreen(raw, { promptId: 1, asOf: "2026-10-09", kind: "scheduled" }, weekFetch(130, 120) as any);
    await runSelectEntry(raw, { promptId: 1, runId: r2 }, weekFetch(130, 120) as any);

    expect(raw.prepare("SELECT entry_id, status, entry_price, stop, entry_date, last_run_id FROM watchlist_entries WHERE symbol = 'FULL1'").all()).toEqual([original]);
    // Only the original pending_selection -> entered event exists.
    expect(raw.prepare("SELECT from_value, to_value FROM entry_events").all()).toEqual([{ from_value: "pending_selection", to_value: "entered" }]);
  });

  it("skips an already-entered entry entirely when /select is re-run for the same run with a different outcome", async () => {
    const raw = createTestDb();
    const { runId } = seedRunAndEntries(raw, [{ symbol: "FULL1", membership: "full_match", status: "pending_selection" }]);
    await runSelectEntry(raw, { promptId: 1, runId }, fakeSelectFetch({ entered: [{ ticker: "FULL1", membership: "full_match", values: {}, failed_ids: [], ep: 100, sl: 95, r: 0.05, entry_price: 101 }], not_confirmed: [], no_point_data: [], watching: [] }) as any);
    const before = raw.prepare("SELECT status, entry_price, stop, entry_date, updated_at FROM watchlist_entries WHERE symbol = 'FULL1'").get();

    const { updated } = await runSelectEntry(raw, { promptId: 1, runId }, fakeSelectFetch({ entered: [], not_confirmed: [{ ticker: "FULL1", membership: "full_match", values: {}, failed_ids: [], ep: 100, sl: 90, r: 0.05, entry_price: 140 }], no_point_data: [], watching: [] }) as any);

    expect(updated).toBe(0);
    expect(raw.prepare("SELECT status, entry_price, stop, entry_date, updated_at FROM watchlist_entries WHERE symbol = 'FULL1'").get()).toEqual(before);
    expect(raw.prepare("SELECT entry_status FROM run_results WHERE symbol = 'FULL1'").get()).toEqual({ entry_status: "entered" });
    expect((raw.prepare("SELECT COUNT(*) AS n FROM entry_events").get() as any).n).toBe(1);
  });

  it("skips a not_confirmed entry too (same freeze as weeklyScreen)", async () => {
    const raw = createTestDb();
    const { runId } = seedRunAndEntries(raw, [{ symbol: "FULL1", membership: "full_match", status: "pending_selection" }]);
    await runSelectEntry(raw, { promptId: 1, runId }, fakeSelectFetch({ entered: [], not_confirmed: [{ ticker: "FULL1", membership: "full_match", values: {}, failed_ids: [], ep: 100, sl: 95, r: 0.05, entry_price: 101 }], no_point_data: [], watching: [] }) as any);
    await runSelectEntry(raw, { promptId: 1, runId }, fakeSelectFetch({ entered: [{ ticker: "FULL1", membership: "full_match", values: {}, failed_ids: [], ep: 100, sl: 95, r: 0.05, entry_price: 150 }], not_confirmed: [], no_point_data: [], watching: [] }) as any);
    expect(raw.prepare("SELECT status, entry_price FROM watchlist_entries WHERE symbol = 'FULL1'").get()).toEqual({ status: "not_confirmed", entry_price: 101 });
  });

  it("never revives a terminal (dropped_from_screen) entry that carries this run as its last_run_id", async () => {
    const raw = createTestDb();
    const { runId } = seedRunAndEntries(raw, [{ symbol: "GONE", membership: "full_match", status: "pending_selection" }]);
    raw.prepare("UPDATE watchlist_entries SET status = 'dropped_from_screen' WHERE symbol = 'GONE'").run();
    await runSelectEntry(raw, { promptId: 1, runId }, fakeSelectFetch({ entered: [{ ticker: "GONE", membership: "full_match", values: {}, failed_ids: [], ep: 100, sl: 95, r: 0.05, entry_price: 101 }], not_confirmed: [], no_point_data: [], watching: [] }) as any);
    expect(raw.prepare("SELECT status, entry_price FROM watchlist_entries WHERE symbol = 'GONE'").get()).toEqual({ status: "dropped_from_screen", entry_price: null });
  });
});
