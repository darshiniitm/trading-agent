import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { runValidatePrior } from "@/server/validatePrior";

const SPEC = {
  spec_version: 4, structure: "literal" as const, timeframe: "1W" as const,
  selection_point: { session_of_week: 1, at: "open" as const },
  conditions: [{ id: "idVstop", role: "event" as const, kind: "indicator" as const, name: "vstop", params: { length: 10, mult: 2, source: "close" }, op: "flip", dir: "long" as const }],
  stop: { from: "idVstop" }, risk_cap_pct: null, near_miss: null,
};

function seedGradableRun(raw: ReturnType<typeof createTestDb>, { gradedRunsBefore }: { gradedRunsBefore: number }) {
  const ownerId = ensureOwnerUser(raw);
  const now = new Date().toISOString();
  raw.prepare(`INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (1, ?, 'x', 'confirmed', ?, ?)`).run(ownerId, now, now);
  raw.prepare(
    `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, confirmed_at)
     VALUES (1, ?, 1, 'Prompt 1', 'x', 'literal', ?, 'h', 'confirmed', 1, 'hyp', 'kill', ?)`
  ).run(ownerId, JSON.stringify(SPEC), now);
  raw.prepare(`INSERT INTO watchlists (watchlist_id, user_id, prompt_id, name, created_at) VALUES (1, ?, 1, 'wl', ?)`).run(ownerId, now);

  for (let i = 0; i < gradedRunsBefore; i++) {
    raw.prepare(`INSERT INTO runs (prompt_id, as_of, kind, status, finished_at) VALUES (1, ?, 'scheduled', 'done', ?)`).run(`2026-0${1 + i}-01`, now);
  }
  const runInfo = raw.prepare(`INSERT INTO runs (prompt_id, as_of, kind, status, finished_at) VALUES (1, '2026-10-02', 'scheduled', 'done', ?)`).run(now);
  const runId = Number(runInfo.lastInsertRowid);
  raw.prepare(`INSERT OR IGNORE INTO symbols (symbol, active) VALUES ('FULL1', 1)`).run();
  raw.prepare(
    `INSERT INTO watchlist_entries (watchlist_id, symbol, first_run_id, last_run_id, membership, status, entry_price, stop, created_at, updated_at)
     VALUES (1, 'FULL1', ?, ?, 'full_match', 'entered', 101, 95, ?, ?)`
  ).run(runId, runId, now, now);
  return { runId };
}

function fakeValidateFetch(body: unknown) {
  return vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify(body) });
}

describe("runValidatePrior", () => {
  it("writes nothing when maturity is not_first_look (fewer than 13 graded weeks)", async () => {
    const raw = createTestDb();
    const { runId } = seedGradableRun(raw, { gradedRunsBefore: 2 });
    const fetchFn = fakeValidateFetch({ graded_weeks: 3, maturity: "not_first_look", rows: [] });

    const result = await runValidatePrior(raw, { promptId: 1, runId }, fetchFn as any);
    expect(result.maturity).toBe("not_first_look");
    const count = raw.prepare("SELECT COUNT(*) AS n FROM validations").get() as any;
    expect(count.n).toBe(0);
  });

  it("aggregates graded rows per horizon into one validations row each, leaving control_ew_return NULL", async () => {
    const raw = createTestDb();
    const { runId } = seedGradableRun(raw, { gradedRunsBefore: 12 });
    const fetchFn = fakeValidateFetch({
      graded_weeks: 13, maturity: "first_look",
      rows: [
        { ticker: "FULL1", signal_week_start: "2026-10-02", horizon_weeks: 1, view: "trade", status: "graded", buy_price: 101, r_Nw: 4.0 },
        { ticker: "FULL1", signal_week_start: "2026-10-02", horizon_weeks: 2, view: "trade", status: "pending", buy_price: 101, r_Nw: null },
      ],
    });

    await runValidatePrior(raw, { promptId: 1, runId }, fetchFn as any);

    const h1 = raw.prepare("SELECT n, ew_return, hit_rate, control_ew_return FROM validations WHERE run_id = ? AND horizon_w = 1").get(runId) as any;
    expect(h1).toEqual({ n: 1, ew_return: 4.0, hit_rate: 1, control_ew_return: null });

    const h2 = raw.prepare("SELECT n FROM validations WHERE run_id = ? AND horizon_w = 2").get(runId) as any;
    expect(h2).toBeUndefined(); // no graded rows for horizon 2 yet (status "pending") -> no row written
  });

  it("passes the owner's entered picks as {ticker, entry_price, sl} to the engine", async () => {
    const raw = createTestDb();
    const { runId } = seedGradableRun(raw, { gradedRunsBefore: 12 });
    const fetchFn = fakeValidateFetch({ graded_weeks: 13, maturity: "first_look", rows: [] });

    await runValidatePrior(raw, { promptId: 1, runId }, fetchFn as any);

    const [, init] = fetchFn.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.picks).toEqual([{ ticker: "FULL1", entry_price: 101, sl: 95 }]);
    expect(body.graded_weeks_so_far).toBe(13);
  });

  it("aggregates only the engine's 'trade' view, never mixing in the 'signal' view rows for the same ticker/horizon", async () => {
    const raw = createTestDb();
    const { runId } = seedGradableRun(raw, { gradedRunsBefore: 12 });
    raw.prepare(`INSERT OR IGNORE INTO symbols (symbol, active) VALUES ('FULL2', 1)`).run();
    raw.prepare(
      `INSERT INTO watchlist_entries (watchlist_id, symbol, first_run_id, last_run_id, membership, status, entry_price, stop, created_at, updated_at)
       VALUES (1, 'FULL2', ?, ?, 'full_match', 'entered', 50, 45, '2026-10-02', '2026-10-02')`
    ).run(runId, runId);
    const fetchFn = fakeValidateFetch({
      graded_weeks: 13, maturity: "first_look",
      rows: [
        // FULL1: signal view says +10, trade view (stopped out) says -3.
        { ticker: "FULL1", signal_week_start: "2026-10-02", horizon_weeks: 1, view: "signal", status: "graded", buy_price: 101, r_Nw: 10.0 },
        { ticker: "FULL1", signal_week_start: "2026-10-02", horizon_weeks: 1, view: "trade", status: "graded", buy_price: 101, r_Nw: -3.0 },
        // FULL2: signal +2, trade +5.
        { ticker: "FULL2", signal_week_start: "2026-10-02", horizon_weeks: 1, view: "signal", status: "graded", buy_price: 50, r_Nw: 2.0 },
        { ticker: "FULL2", signal_week_start: "2026-10-02", horizon_weeks: 1, view: "trade", status: "graded", buy_price: 50, r_Nw: 5.0 },
        // A t1_literal-style not-gradable row (no view key) is ignored too.
        { ticker: "FULL3", signal_week_start: "2026-10-02", horizon_weeks: 1, status: "not_gradable_weekly_downtrend", buy_price: 10 },
      ],
    });

    await runValidatePrior(raw, { promptId: 1, runId }, fetchFn as any);

    const h1 = raw.prepare("SELECT n, ew_return, hit_rate FROM validations WHERE run_id = ? AND horizon_w = 1").get(runId) as any;
    expect(h1).toEqual({ n: 2, ew_return: 1.0, hit_rate: 0.5 }); // (-3 + 5) / 2; one of two > 0
  });

  it("grades a pick under the run it was entered in (last_run_id), even when it was first seen in an earlier run", async () => {
    const raw = createTestDb();
    const { runId: enteredRunId } = seedGradableRun(raw, { gradedRunsBefore: 12 });
    // Re-point FULL1's first_run_id at an earlier run (first seen as a near-miss there).
    const earlierRunId = (raw.prepare("SELECT run_id FROM runs WHERE as_of = '2026-01-01'").get() as { run_id: number }).run_id;
    raw.prepare("UPDATE watchlist_entries SET first_run_id = ? WHERE symbol = 'FULL1'").run(earlierRunId);

    const atEntered = fakeValidateFetch({ graded_weeks: 13, maturity: "first_look", rows: [] });
    await runValidatePrior(raw, { promptId: 1, runId: enteredRunId }, atEntered as any);
    expect(JSON.parse(atEntered.mock.calls[0][1].body).picks).toEqual([{ ticker: "FULL1", entry_price: 101, sl: 95 }]);

    const atEarlier = fakeValidateFetch({ graded_weeks: 1, maturity: "not_first_look", rows: [] });
    await runValidatePrior(raw, { promptId: 1, runId: earlierRunId }, atEarlier as any);
    expect(JSON.parse(atEarlier.mock.calls[0][1].body).picks).toEqual([]);
  });

  it("reports complete=false while any horizon is still pending, true once none are", async () => {
    const raw = createTestDb();
    const { runId } = seedGradableRun(raw, { gradedRunsBefore: 12 });
    const pending = await runValidatePrior(raw, { promptId: 1, runId }, fakeValidateFetch({
      graded_weeks: 13, maturity: "first_look",
      rows: [{ ticker: "FULL1", signal_week_start: "2026-10-02", horizon_weeks: 2, view: "trade", status: "pending", buy_price: 101, r_Nw: null }],
    }) as any);
    expect(pending.complete).toBe(false);
    const done = await runValidatePrior(raw, { promptId: 1, runId }, fakeValidateFetch({
      graded_weeks: 13, maturity: "first_look",
      rows: [{ ticker: "FULL1", signal_week_start: "2026-10-02", horizon_weeks: 2, view: "trade", status: "graded", buy_price: 101, r_Nw: 1 }],
    }) as any);
    expect(done.complete).toBe(true);
  });
});
