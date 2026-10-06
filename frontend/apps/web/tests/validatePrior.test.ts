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
    `INSERT INTO run_results (run_id, symbol, membership, in_forward_record, cond_json, ep, sl, entry_status, entry_price)
     VALUES (?, 'FULL1', 'full_match', 0, '{}', 101, 95, 'entered', 101)`
  ).run(runId);
  raw.prepare(
    `INSERT INTO watchlist_entries (watchlist_id, symbol, first_run_id, last_run_id, membership, status, entry_price, stop, created_at, updated_at)
     VALUES (1, 'FULL1', ?, ?, 'full_match', 'entered', 101, 95, ?, ?)`
  ).run(runId, runId, now, now);
  return { runId };
}

function fakeValidateFetch(body: unknown) {
  return vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify(body) });
}

// Prompt + N filler graded runs, with no run_results/watchlist_entries rows
// of its own — individual N1-regression tests add their own runs and
// run_results rows on top, deliberately WITHOUT ever touching
// watchlist_entries, to prove validatePrior's picks selection no longer
// depends on it at all.
function seedPromptWithGradedRuns(raw: ReturnType<typeof createTestDb>, gradedRunsBefore: number) {
  const ownerId = ensureOwnerUser(raw);
  const now = new Date().toISOString();
  raw.prepare(`INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (1, ?, 'x', 'confirmed', ?, ?)`).run(ownerId, now, now);
  raw.prepare(
    `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, confirmed_at)
     VALUES (1, ?, 1, 'Prompt 1', 'x', 'literal', ?, 'h', 'confirmed', 1, 'hyp', 'kill', ?)`
  ).run(ownerId, JSON.stringify(SPEC), now);
  for (let i = 0; i < gradedRunsBefore; i++) {
    raw.prepare(`INSERT INTO runs (prompt_id, as_of, kind, status, finished_at) VALUES (1, ?, 'scheduled', 'done', ?)`).run(`2026-0${1 + i}-01`, now);
  }
}

function insertRun(raw: ReturnType<typeof createTestDb>, asOf: string): number {
  const now = new Date().toISOString();
  const info = raw.prepare(`INSERT INTO runs (prompt_id, as_of, kind, status, finished_at) VALUES (1, ?, 'scheduled', 'done', ?)`).run(asOf, now);
  return Number(info.lastInsertRowid);
}

function insertRunResult(raw: ReturnType<typeof createTestDb>, runId: number, symbol: string, row: { entryStatus: string; entryPrice: number | null; sl: number | null }) {
  raw.prepare(`INSERT OR IGNORE INTO symbols (symbol, active) VALUES (?, 1)`).run(symbol);
  raw.prepare(
    `INSERT INTO run_results (run_id, symbol, membership, in_forward_record, cond_json, ep, sl, entry_status, entry_price)
     VALUES (?, ?, 'full_match', 0, '{}', ?, ?, ?, ?)`
  ).run(runId, symbol, row.entryPrice, row.sl, row.entryStatus, row.entryPrice);
}

// watchlist_id 1 for a prompt seeded via seedPromptWithGradedRuns, used only
// by the "real co-existing state" N1a/N1b variants below, which deliberately
// seed the actual production parallel state (a watchlist_entries row DOES
// exist, frozen, alongside run_results) to prove the fix holds even when
// that stale row is sitting right there — not just in its absence.
function insertWatchlist(raw: ReturnType<typeof createTestDb>) {
  const ownerId = ensureOwnerUser(raw);
  const now = new Date().toISOString();
  raw.prepare(`INSERT INTO watchlists (watchlist_id, user_id, prompt_id, name, created_at) VALUES (1, ?, 1, 'wl', ?)`).run(ownerId, now);
}

// A frozen watchlist_entries row exactly as selectEntry.ts would leave one
// for a real 'entered'/'not_confirmed' outcome: first_run_id/last_run_id
// pinned to the run it was resolved on, never touched again by any later
// weeklyScreen.ts run (FROZEN_STATUSES skip-if-frozen logic, untouched by
// this fix).
function insertFrozenWatchlistEntry(
  raw: ReturnType<typeof createTestDb>,
  symbol: string,
  runId: number,
  status: "entered" | "not_confirmed",
  entryPrice: number,
  stop: number
) {
  const now = new Date().toISOString();
  raw.prepare(
    `INSERT INTO watchlist_entries (watchlist_id, symbol, first_run_id, last_run_id, membership, status, entry_price, stop, created_at, updated_at)
     VALUES (1, ?, ?, ?, 'full_match', ?, ?, ?, ?, ?)`
  ).run(symbol, runId, runId, status, entryPrice, stop, now, now);
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

  it("passes this run's entered picks (sourced from run_results) as {ticker, entry_price, sl} to the engine", async () => {
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
      `INSERT INTO run_results (run_id, symbol, membership, in_forward_record, cond_json, ep, sl, entry_status, entry_price)
       VALUES (?, 'FULL2', 'full_match', 0, '{}', 50, 45, 'entered', 50)`
    ).run(runId);
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

  // --- N1 regressions: validatePrior's picks come from run_results, an
  // immutable per-(run_id, symbol) fact, not from watchlist_entries (whose
  // rows freeze once a symbol reaches 'entered'/'not_confirmed', which used
  // to silently exclude exactly the two scenarios below from ever being
  // graded).

  it("N1a: a symbol not_confirmed on run 1 is never graded there, but IS graded on run 2 once it genuinely enters", async () => {
    const raw = createTestDb();
    seedPromptWithGradedRuns(raw, 12);
    const run1 = insertRun(raw, "2026-09-25");
    insertRunResult(raw, run1, "FULL1", { entryStatus: "not_confirmed", entryPrice: 101, sl: 95 });
    const run2 = insertRun(raw, "2026-10-02");
    insertRunResult(raw, run2, "FULL1", { entryStatus: "entered", entryPrice: 105, sl: 98 });

    const atRun1 = fakeValidateFetch({ graded_weeks: 13, maturity: "first_look", rows: [] });
    await runValidatePrior(raw, { promptId: 1, runId: run1 }, atRun1 as any);
    expect(JSON.parse(atRun1.mock.calls[0][1].body).picks).toEqual([]);

    const atRun2 = fakeValidateFetch({ graded_weeks: 14, maturity: "first_look", rows: [] });
    await runValidatePrior(raw, { promptId: 1, runId: run2 }, atRun2 as any);
    expect(JSON.parse(atRun2.mock.calls[0][1].body).picks).toEqual([{ ticker: "FULL1", entry_price: 105, sl: 98 }]);
  });

  it("N1a (real co-existing state): a stale frozen watchlist_entries row from run 1 does not block run 2's fresh pick", async () => {
    const raw = createTestDb();
    seedPromptWithGradedRuns(raw, 12);
    insertWatchlist(raw);
    const run1 = insertRun(raw, "2026-09-25");
    insertRunResult(raw, run1, "FULL1", { entryStatus: "not_confirmed", entryPrice: 101, sl: 95 });
    // Real production parallel state: selectEntry.ts also writes a
    // watchlist_entries row for this outcome, frozen forever at run 1
    // (weeklyScreen.ts's FROZEN_STATUSES, untouched by this fix).
    insertFrozenWatchlistEntry(raw, "FULL1", run1, "not_confirmed", 101, 95);

    const run2 = insertRun(raw, "2026-10-02");
    insertRunResult(raw, run2, "FULL1", { entryStatus: "entered", entryPrice: 105, sl: 98 });
    // In real usage weeklyScreen.ts never touches the frozen row on run 2
    // either — it stays pinned exactly at run 1, forever.

    const atRun2 = fakeValidateFetch({ graded_weeks: 14, maturity: "first_look", rows: [] });
    await runValidatePrior(raw, { promptId: 1, runId: run2 }, atRun2 as any);
    expect(JSON.parse(atRun2.mock.calls[0][1].body).picks).toEqual([{ ticker: "FULL1", entry_price: 105, sl: 98 }]);
    // Sanity: the frozen watchlist_entries row is still exactly as it was —
    // the fix doesn't need it to change, and doesn't touch it.
    expect(raw.prepare("SELECT status, entry_price, stop, last_run_id FROM watchlist_entries WHERE symbol = 'FULL1'").get())
      .toEqual({ status: "not_confirmed", entry_price: 101, stop: 95, last_run_id: run1 });
  });

  it("N1b: a symbol entered on run 1, dropped, then freshly entered again on run 3 is graded under run 3 too", async () => {
    const raw = createTestDb();
    seedPromptWithGradedRuns(raw, 12);
    const run1 = insertRun(raw, "2026-09-18");
    insertRunResult(raw, run1, "FULL1", { entryStatus: "entered", entryPrice: 101, sl: 95 });
    // run 2: FULL1 drops off the screen entirely (no run_results row for it at all).
    insertRun(raw, "2026-09-25");
    const run3 = insertRun(raw, "2026-10-02");
    insertRunResult(raw, run3, "FULL1", { entryStatus: "entered", entryPrice: 130, sl: 120 });

    const atRun1 = fakeValidateFetch({ graded_weeks: 13, maturity: "first_look", rows: [] });
    await runValidatePrior(raw, { promptId: 1, runId: run1 }, atRun1 as any);
    expect(JSON.parse(atRun1.mock.calls[0][1].body).picks).toEqual([{ ticker: "FULL1", entry_price: 101, sl: 95 }]);

    const atRun3 = fakeValidateFetch({ graded_weeks: 15, maturity: "first_look", rows: [] });
    await runValidatePrior(raw, { promptId: 1, runId: run3 }, atRun3 as any);
    expect(JSON.parse(atRun3.mock.calls[0][1].body).picks).toEqual([{ ticker: "FULL1", entry_price: 130, sl: 120 }]);
  });

  it("N1b (real co-existing state): a stale frozen 'entered' watchlist_entries row from run 1 does not block run 3's fresh re-entry", async () => {
    const raw = createTestDb();
    seedPromptWithGradedRuns(raw, 12);
    insertWatchlist(raw);
    const run1 = insertRun(raw, "2026-09-18");
    insertRunResult(raw, run1, "FULL1", { entryStatus: "entered", entryPrice: 101, sl: 95 });
    // Real production parallel state: selectEntry.ts also writes a
    // watchlist_entries row for this outcome, frozen forever at run 1.
    insertFrozenWatchlistEntry(raw, "FULL1", run1, "entered", 101, 95);

    // run 2: FULL1 drops off the screen. In real usage weeklyScreen.ts never
    // drops a frozen ('entered') entry (DROPPABLE_STATUSES excludes
    // FROZEN_STATUSES), so the row above stays exactly as it is.
    insertRun(raw, "2026-09-25");
    const run3 = insertRun(raw, "2026-10-02");
    insertRunResult(raw, run3, "FULL1", { entryStatus: "entered", entryPrice: 130, sl: 120 });
    // In real usage weeklyScreen.ts's selectOpenEntry would find the frozen
    // row still occupying this (watchlist, symbol) slot (it's not in a
    // terminal status) and skip it — no new watchlist_entries row is ever
    // created for FULL1's run-3 re-entry. run_results, by contrast, gets a
    // brand-new (run_id, symbol) row every time, which is exactly why this
    // fix sources picks from there.

    const atRun3 = fakeValidateFetch({ graded_weeks: 15, maturity: "first_look", rows: [] });
    await runValidatePrior(raw, { promptId: 1, runId: run3 }, atRun3 as any);
    expect(JSON.parse(atRun3.mock.calls[0][1].body).picks).toEqual([{ ticker: "FULL1", entry_price: 130, sl: 120 }]);
    expect(raw.prepare("SELECT status, entry_price, stop, last_run_id FROM watchlist_entries WHERE symbol = 'FULL1'").get())
      .toEqual({ status: "entered", entry_price: 101, stop: 95, last_run_id: run1 });
  });

  it("does not depend on watchlist_entries or the owner's watchlist at all", async () => {
    const raw = createTestDb();
    seedPromptWithGradedRuns(raw, 12);
    // Deliberately no watchlists row for this prompt at all.
    const run = insertRun(raw, "2026-10-02");
    insertRunResult(raw, run, "FULL1", { entryStatus: "entered", entryPrice: 101, sl: 95 });

    const fetchFn = fakeValidateFetch({ graded_weeks: 13, maturity: "first_look", rows: [] });
    await runValidatePrior(raw, { promptId: 1, runId: run }, fetchFn as any);
    expect(JSON.parse(fetchFn.mock.calls[0][1].body).picks).toEqual([{ ticker: "FULL1", entry_price: 101, sl: 95 }]);
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
