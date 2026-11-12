import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { runWeeklyScreen } from "@/server/weeklyScreen";
import { runSelectEntry } from "@/server/selectEntry";
import { prep } from "./helpers/prep";
import type { Db } from "@/server/db/pg";

const SPEC = {
  spec_version: 4, structure: "literal" as const, timeframe: "1W" as const,
  selection_point: { session_of_week: 1, at: "open" as const },
  conditions: [{ id: "idMcap", role: "filter" as const, kind: "field" as const, name: "mcap_cr", params: {}, op: "between", value: [10000, 50000] }],
  stop: null, risk_cap_pct: null, near_miss: null,
};

async function seedPromptWithTwoWatchlists(raw: Db) {
  const ownerId = await ensureOwnerUser(raw);
  const now = "2026-10-01T00:00:00.000Z";
  await prep(raw, `INSERT INTO users (user_id, display_name, role, status, created_at) VALUES (2, 'Second', 'member', 'active', ?)`).run(now);
  await prep(raw, `INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (1, ?, 'x', 'confirmed', ?, ?)`).run(ownerId, now, now);
  await prep(raw, 
    `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, confirmed_at)
     VALUES (1, ?, 1, 'Prompt 1', 'x', 'literal', ?, 'h', 'confirmed', 1, 'hyp', 'kill', ?)`
  ).run(ownerId, JSON.stringify(SPEC), now);
  await prep(raw, `INSERT INTO prompt_conditions (prompt_id, cond_no, role, kind, name, op, value_origin) VALUES (1, 1, 'filter', 'field', 'mcap_cr', 'between', 'user_answer')`).run();
  await prep(raw, `INSERT INTO watchlists (watchlist_id, user_id, prompt_id, name, created_at) VALUES (1, ?, 1, 'owner wl', ?)`).run(ownerId, now);
  await prep(raw, `INSERT INTO watchlists (watchlist_id, user_id, prompt_id, name, created_at) VALUES (2, 2, 1, 'follower wl', ?)`).run(now);
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
    const raw = await createTestDb();
    await seedPromptWithTwoWatchlists(raw);
    const fetchFn = fakeScreenFetch([{ ticker: "FULL1", membership: "full_match", values: { idMcap: 25000 }, failed_ids: [], ep: 100, sl: 95, r: 0.05 }]);

    const { runId } = await runWeeklyScreen(raw, { promptId: 1, asOf: "2026-10-02", kind: "scheduled" }, fetchFn as any);
    expect(runId).toBeGreaterThan(0);

    const entries = await prep(raw, "SELECT watchlist_id, symbol, status FROM watchlist_entries ORDER BY watchlist_id").all() as any[];
    expect(entries).toEqual([
      { watchlist_id: 1, symbol: "FULL1", status: "pending_selection" },
      { watchlist_id: 2, symbol: "FULL1", status: "pending_selection" },
    ]);
  });

  it("drops an open entry no longer present in this run's candidates, and logs the event", async () => {
    const raw = await createTestDb();
    await seedPromptWithTwoWatchlists(raw);
    await runWeeklyScreen(raw, { promptId: 1, asOf: "2026-10-02", kind: "scheduled" }, fakeScreenFetch([{ ticker: "FULL1", membership: "full_match", values: {}, failed_ids: [], ep: 100, sl: 95, r: 0.05 }]) as any);

    await runWeeklyScreen(raw, { promptId: 1, asOf: "2026-10-09", kind: "scheduled" }, fakeScreenFetch([]) as any);

    const entry = await prep(raw, "SELECT status FROM watchlist_entries WHERE watchlist_id = 1 AND symbol = 'FULL1'").get() as any;
    expect(entry.status).toBe("dropped_from_screen");
    const events = await prep(raw, "SELECT type, to_value FROM entry_events").all() as any[];
    expect(events.some((e) => e.type === "dropped_from_screen" && e.to_value === "dropped_from_screen")).toBe(true);
  });

  it("updates an existing open entry's membership (near_miss -> full_match) instead of creating a duplicate", async () => {
    const raw = await createTestDb();
    await seedPromptWithTwoWatchlists(raw);
    await runWeeklyScreen(raw, { promptId: 1, asOf: "2026-10-02", kind: "scheduled" }, fakeScreenFetch([{ ticker: "X", membership: "near_miss", values: {}, failed_ids: ["idMcap"], ep: 10, sl: null, r: null }]) as any);

    await runWeeklyScreen(raw, { promptId: 1, asOf: "2026-10-09", kind: "scheduled" }, fakeScreenFetch([{ ticker: "X", membership: "full_match", values: {}, failed_ids: [], ep: 11, sl: 10, r: 0.1 }]) as any);

    const rows = await prep(raw, "SELECT membership FROM watchlist_entries WHERE watchlist_id = 1 AND symbol = 'X'").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].membership).toBe("full_match");
  });

  it("handles zero candidates and zero watchlists without crashing", async () => {
    const raw = await createTestDb();
    const ownerId = await ensureOwnerUser(raw);
    const now = new Date().toISOString();
    await prep(raw, `INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (1, ?, 'x', 'confirmed', ?, ?)`).run(ownerId, now, now);
    await prep(raw, 
      `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, confirmed_at)
       VALUES (1, ?, 1, 'Prompt 1', 'x', 'literal', ?, 'h', 'confirmed', 1, 'hyp', 'kill', ?)`
    ).run(ownerId, JSON.stringify(SPEC), now);
    const { runId } = await runWeeklyScreen(raw, { promptId: 1, asOf: "2026-10-02", kind: "scheduled" }, fakeScreenFetch([]) as any);
    expect(runId).toBeGreaterThan(0);
  });

  // --- Freeze regression (final-review C1/C2): once an entry is entered or
  // not_confirmed it is a resolved fact; later weekly screens leave it alone.

  async function enterFull1(raw: Db, status: "entered" | "not_confirmed" = "entered") {
    const { runId } = await runWeeklyScreen(
      raw, { promptId: 1, asOf: "2026-10-02", kind: "scheduled" },
      fakeScreenFetch([{ ticker: "FULL1", membership: "full_match", values: { idMcap: 25000 }, failed_ids: [], ep: 100, sl: 95, r: 0.05 }]) as any
    );
    const pick = { ticker: "FULL1", membership: "full_match", values: {}, failed_ids: [], ep: 100, sl: 95, r: 0.05, entry_price: 101 };
    const selectBody = { entered: status === "entered" ? [pick] : [], not_confirmed: status === "not_confirmed" ? [pick] : [], no_point_data: [], watching: [] };
    await runSelectEntry(raw, { promptId: 1, runId }, vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify(selectBody) }) as any);
    return { firstRunId: runId };
  }

  async function frozenSnapshot(raw: Db) {
    return await prep(raw, "SELECT entry_id, watchlist_id, membership, status, entry_price, stop, entry_date, last_run_id FROM watchlist_entries WHERE symbol = 'FULL1' ORDER BY watchlist_id")
      .all();
  }

  for (const nextMembership of ["near_miss", "rejected_risk_cap"] as const) {
    it(`leaves an entered entry untouched when next week's screen returns it as ${nextMembership} (no CHECK violation, no event)`, async () => {
      const raw = await createTestDb();
      await seedPromptWithTwoWatchlists(raw);
      const { firstRunId } = await enterFull1(raw);
      const before = await frozenSnapshot(raw) as any[];
      expect(before.map((e) => e.status)).toEqual(["entered", "entered"]);
      expect(before.every((e) => e.entry_price === 101 && e.last_run_id === firstRunId)).toBe(true);
      const eventsBefore = (await prep(raw, "SELECT COUNT(*) AS n FROM entry_events").get() as any).n;

      const { runId: secondRunId } = await runWeeklyScreen(
        raw, { promptId: 1, asOf: "2026-10-09", kind: "scheduled" },
        fakeScreenFetch([{ ticker: "FULL1", membership: nextMembership, values: {}, failed_ids: ["idMcap"], ep: 90, sl: null, r: null }]) as any
      );

      expect(await frozenSnapshot(raw)).toEqual(before);
      expect((await prep(raw, "SELECT COUNT(*) AS n FROM entry_events").get() as any).n).toBe(eventsBefore);
      expect(await prep(raw, "SELECT COUNT(*) AS n FROM entry_events WHERE type = 'membership_changed'").get()).toEqual({ n: 0 });
      // The week's own run_results row still records what the screen said.
      expect(await prep(raw, "SELECT membership FROM run_results WHERE run_id = ? AND symbol = 'FULL1'").get(secondRunId)).toEqual({ membership: nextMembership });
      // And no duplicate entry was created for the re-seen symbol.
      expect((await prep(raw, "SELECT COUNT(*) AS n FROM watchlist_entries WHERE symbol = 'FULL1'").get() as any).n).toBe(2);
    });
  }

  it("leaves a not_confirmed entry untouched when next week's screen returns it as near_miss", async () => {
    const raw = await createTestDb();
    await seedPromptWithTwoWatchlists(raw);
    await enterFull1(raw, "not_confirmed");
    const before = await frozenSnapshot(raw) as any[];
    expect(before.map((e) => e.status)).toEqual(["not_confirmed", "not_confirmed"]);

    await runWeeklyScreen(
      raw, { promptId: 1, asOf: "2026-10-09", kind: "scheduled" },
      fakeScreenFetch([{ ticker: "FULL1", membership: "near_miss", values: {}, failed_ids: ["idMcap"], ep: 90, sl: null, r: null }]) as any
    );
    expect(await frozenSnapshot(raw)).toEqual(before);
  });

  it("never marks a frozen entry dropped_from_screen, whether its symbol is re-seen or absent", async () => {
    const raw = await createTestDb();
    await seedPromptWithTwoWatchlists(raw);
    await enterFull1(raw);
    const before = await frozenSnapshot(raw);

    // Re-seen as full_match: untouched.
    await runWeeklyScreen(
      raw, { promptId: 1, asOf: "2026-10-09", kind: "scheduled" },
      fakeScreenFetch([{ ticker: "FULL1", membership: "full_match", values: {}, failed_ids: [], ep: 120, sl: 110, r: 0.08 }]) as any
    );
    expect(await frozenSnapshot(raw)).toEqual(before);

    // Absent entirely: still untouched (a live position, not an abandoned candidate).
    await runWeeklyScreen(raw, { promptId: 1, asOf: "2026-10-16", kind: "scheduled" }, fakeScreenFetch([]) as any);
    expect(await frozenSnapshot(raw)).toEqual(before);
    expect(await prep(raw, "SELECT COUNT(*) AS n FROM entry_events WHERE type = 'dropped_from_screen'").get()).toEqual({ n: 0 });
  });
});
