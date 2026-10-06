import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { runSelectEntry } from "@/server/selectEntry";

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

  it("does not log an event when status is unchanged", async () => {
    const raw = createTestDb();
    const { runId } = seedRunAndEntries(raw, [{ symbol: "FULL1", membership: "full_match", status: "entered" }]);
    const fetchFn = fakeSelectFetch({ entered: [{ ticker: "FULL1", membership: "full_match", values: {}, failed_ids: [], ep: 100, sl: 95, r: 0.05, entry_price: 101 }], not_confirmed: [], no_point_data: [], watching: [] });
    await runSelectEntry(raw, { promptId: 1, runId }, fetchFn as any);
    const events = raw.prepare("SELECT COUNT(*) AS n FROM entry_events").get() as any;
    expect(events.n).toBe(0);
  });
});
