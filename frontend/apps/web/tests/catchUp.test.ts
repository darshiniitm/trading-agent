import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { runCatchUp } from "@/server/catchUp";
import { runWeeklyScreen } from "@/server/weeklyScreen";
import { runSelectEntry } from "@/server/selectEntry";

const SPEC = {
  spec_version: 4, structure: "literal" as const, timeframe: "1W" as const,
  selection_point: { session_of_week: 1, at: "open" as const },
  conditions: [], stop: null, risk_cap_pct: null, near_miss: null,
};

function seedPromptWithOneRun(raw: ReturnType<typeof createTestDb>, lastAsOf: string) {
  const ownerId = ensureOwnerUser(raw);
  const now = new Date().toISOString();
  raw.prepare(`INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (1, ?, 'x', 'confirmed', ?, ?)`).run(ownerId, now, now);
  raw.prepare(
    `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, confirmed_at)
     VALUES (1, ?, 1, 'Prompt 1', 'x', 'literal', ?, 'h', 'confirmed', 1, 'hyp', 'kill', ?)`
  ).run(ownerId, JSON.stringify(SPEC), now);
  raw.prepare(`INSERT INTO watchlists (watchlist_id, user_id, prompt_id, name, created_at) VALUES (1, ?, 1, 'wl', ?)`).run(ownerId, now);
  raw.prepare(`INSERT INTO runs (prompt_id, as_of, kind, status, finished_at) VALUES (1, ?, 'scheduled', 'done', ?)`).run(lastAsOf, now);
}

// The as_of of every /validate call a fake fetch received, in call order.
function validateCallAsOfs(fetchFn: { mock: { calls: any[][] } }): string[] {
  return fetchFn.mock.calls.filter(([url]) => String(url).endsWith("/validate")).map(([, init]) => JSON.parse(init.body).as_of);
}

function fakeFetch() {
  return vi.fn().mockImplementation(async (url: string) => {
    if (url.endsWith("/health")) return { ok: true, text: async () => JSON.stringify({ status: "ok", engine_git_sha: "abc", last_bar_date: "2026-10-16", data_snapshot_hash: null }) };
    if (url.endsWith("/arms/register")) return { ok: true, text: async () => JSON.stringify({ prompt_id: 1, status: "active" }) };
    if (url.endsWith("/screen")) return { ok: true, text: async () => JSON.stringify({ candidates: [], applied_steps: [], funnel: [], sector_view: [] }) };
    if (url.endsWith("/select")) return { ok: true, text: async () => JSON.stringify({ entered: [], not_confirmed: [], no_point_data: [], watching: [] }) };
    if (url.endsWith("/validate")) return { ok: true, text: async () => JSON.stringify({ graded_weeks: 1, maturity: "not_first_look", rows: [] }) };
    throw new Error(`unexpected url ${url}`);
  });
}

// /validate always throws (simulating an engine/network failure on that
// endpoint specifically) while /screen and /select succeed normally.
function fetchWithValidateFailure() {
  return vi.fn().mockImplementation(async (url: string) => {
    if (url.endsWith("/health")) return { ok: true, text: async () => JSON.stringify({ status: "ok", engine_git_sha: "abc", last_bar_date: "2026-10-16", data_snapshot_hash: null }) };
    if (url.endsWith("/arms/register")) return { ok: true, text: async () => JSON.stringify({ prompt_id: 1, status: "active" }) };
    if (url.endsWith("/screen")) return { ok: true, text: async () => JSON.stringify({ candidates: [], applied_steps: [], funnel: [], sector_view: [] }) };
    if (url.endsWith("/select")) return { ok: true, text: async () => JSON.stringify({ entered: [], not_confirmed: [], no_point_data: [], watching: [] }) };
    if (url.endsWith("/validate")) throw new Error("validate engine down");
    throw new Error(`unexpected url ${url}`);
  });
}

// /select throws only for the given week's as_of; every other call
// (including /select for other weeks) succeeds normally.
function fetchFailingSelectFor(asOfToFail: string) {
  return vi.fn().mockImplementation(async (url: string, init?: { body?: string }) => {
    if (url.endsWith("/health")) return { ok: true, text: async () => JSON.stringify({ status: "ok", engine_git_sha: "abc", last_bar_date: "2026-10-16", data_snapshot_hash: null }) };
    if (url.endsWith("/arms/register")) return { ok: true, text: async () => JSON.stringify({ prompt_id: 1, status: "active" }) };
    if (url.endsWith("/screen")) return { ok: true, text: async () => JSON.stringify({ candidates: [], applied_steps: [], funnel: [], sector_view: [] }) };
    if (url.endsWith("/select")) {
      const body = JSON.parse(init?.body ?? "{}");
      if (body.as_of === asOfToFail) throw new Error("select engine down");
      return { ok: true, text: async () => JSON.stringify({ entered: [], not_confirmed: [], no_point_data: [], watching: [] }) };
    }
    if (url.endsWith("/validate")) return { ok: true, text: async () => JSON.stringify({ graded_weeks: 1, maturity: "not_first_look", rows: [] }) };
    throw new Error(`unexpected url ${url}`);
  });
}

describe("runCatchUp", () => {
  it("runs one weekly cycle per missed Friday between the last run and the engine's last_bar_date", async () => {
    const raw = createTestDb();
    seedPromptWithOneRun(raw, "2026-10-02");
    const fetchFn = fakeFetch();

    const { weeksRun } = await runCatchUp(raw, { promptId: 1 }, fetchFn as any);
    expect(weeksRun).toEqual(["2026-10-09", "2026-10-16"]);

    const runs = raw.prepare("SELECT as_of FROM runs WHERE prompt_id = 1 ORDER BY as_of").all() as any[];
    expect(runs.map((r) => r.as_of)).toEqual(["2026-10-02", "2026-10-09", "2026-10-16"]);
  });

  it("is a no-op on a second call once every missed week is already caught up", async () => {
    const raw = createTestDb();
    seedPromptWithOneRun(raw, "2026-10-02");
    const fetchFn = fakeFetch();
    await runCatchUp(raw, { promptId: 1 }, fetchFn as any);

    const { weeksRun } = await runCatchUp(raw, { promptId: 1 }, fetchFn as any);
    expect(weeksRun).toEqual([]);
    const runCount = raw.prepare("SELECT COUNT(*) AS n FROM runs WHERE prompt_id = 1").get() as any;
    expect(runCount.n).toBe(3);
  });

  it("returns no weeks when already caught up to last_bar_date", async () => {
    const raw = createTestDb();
    seedPromptWithOneRun(raw, "2026-10-16");
    const fetchFn = fakeFetch();
    const { weeksRun } = await runCatchUp(raw, { promptId: 1 }, fetchFn as any);
    expect(weeksRun).toEqual([]);
  });

  it("still completes and advances past a week whose runValidatePrior throws", async () => {
    const raw = createTestDb();
    seedPromptWithOneRun(raw, "2026-10-02");
    const fetchFn = fetchWithValidateFailure();

    const { weeksRun } = await runCatchUp(raw, { promptId: 1 }, fetchFn as any);
    expect(weeksRun).toEqual(["2026-10-09", "2026-10-16"]);

    const jobs = raw
      .prepare("SELECT as_of, status FROM jobs WHERE type = 'catch_up' AND prompt_id = 1 ORDER BY as_of")
      .all() as { as_of: string; status: string }[];
    expect(jobs.map((j) => j.status)).toEqual(["done", "done"]);

    const runs = raw.prepare("SELECT as_of FROM runs WHERE prompt_id = 1 ORDER BY as_of").all() as any[];
    expect(runs.map((r) => r.as_of)).toEqual(["2026-10-02", "2026-10-09", "2026-10-16"]);

    // The grading failure is no longer swallowed silently: each prior run's
    // validate_prior attempt is its own job, recorded 'failed' with the error
    // (so it is retried on a later catch-up), and reported back to the caller.
    const validateJobs = raw
      .prepare("SELECT as_of, status, error FROM jobs WHERE type = 'validate_prior' AND prompt_id = 1 ORDER BY as_of")
      .all() as { as_of: string; status: string; error: string }[];
    expect(validateJobs.map((j) => [j.as_of, j.status])).toEqual([
      ["2026-10-02", "failed"],
      ["2026-10-09", "failed"],
    ]);
    expect(validateJobs.every((j) => j.error === "validate engine down")).toBe(true);
  });

  it("never grades the week's own brand-new run, only earlier runs", async () => {
    const raw = createTestDb();
    seedPromptWithOneRun(raw, "2026-10-02");
    const fetchFn = fakeFetch();
    await runCatchUp(raw, { promptId: 1 }, fetchFn as any);

    const validatedAsOfs = validateCallAsOfs(fetchFn);
    // Week 10-09 grades 10-02; week 10-16 grades 10-09 (10-02 is already
    // 'done' — not_first_look is final). 10-16 itself is never graded.
    expect(validatedAsOfs).toEqual(["2026-10-02", "2026-10-09"]);
  });

  it("propagates a runSelectEntry failure, then retries that exact week on the next call by reusing its runs row", async () => {
    const raw = createTestDb();
    seedPromptWithOneRun(raw, "2026-10-02");
    const failingFetch = fetchFailingSelectFor("2026-10-16");

    await expect(runCatchUp(raw, { promptId: 1 }, failingFetch as any)).rejects.toThrow("select engine down");

    // runWeeklyScreen committed its runs row for 2026-10-09 (done) and for
    // 2026-10-16 (screen step succeeded before select failed) — the job
    // for 2026-10-16 is 'failed', not 'done'.
    const runsAfterFailure = raw.prepare("SELECT as_of FROM runs WHERE prompt_id = 1 ORDER BY as_of").all() as any[];
    expect(runsAfterFailure.map((r) => r.as_of)).toEqual(["2026-10-02", "2026-10-09", "2026-10-16"]);

    const jobsAfterFailure = raw
      .prepare("SELECT as_of, status FROM jobs WHERE type = 'catch_up' AND prompt_id = 1 ORDER BY as_of")
      .all() as { as_of: string; status: string }[];
    expect(jobsAfterFailure).toEqual([
      { as_of: "2026-10-09", status: "done" },
      { as_of: "2026-10-16", status: "failed" },
    ]);

    const okFetch = fakeFetch();
    const { weeksRun } = await runCatchUp(raw, { promptId: 1 }, okFetch as any);
    expect(weeksRun).toEqual(["2026-10-16"]);

    // No duplicate runs row was inserted for 2026-10-16 on retry (which
    // would otherwise violate ux_runs_graded's UNIQUE(prompt_id, as_of)).
    const runsAfterRetry = raw.prepare("SELECT as_of FROM runs WHERE prompt_id = 1 ORDER BY as_of").all() as any[];
    expect(runsAfterRetry.map((r) => r.as_of)).toEqual(["2026-10-02", "2026-10-09", "2026-10-16"]);

    const jobsAfterRetry = raw
      .prepare("SELECT as_of, status FROM jobs WHERE type = 'catch_up' AND prompt_id = 1 ORDER BY as_of")
      .all() as { as_of: string; status: string }[];
    expect(jobsAfterRetry.map((j) => j.status)).toEqual(["done", "done"]);
  });

  // --- Final-review C3/I3: a multi-week timeline. /validate grades a horizon
  // only once its bar exists (as_of + 7*h <= the engine's last bar), exactly
  // like the real grade_horizons — so a run's horizon 1 can only be written
  // on a LATER week's catch-up, and horizons 2/3 later still.
  it("grades each run's horizons as they mature over later weeks, and never re-grades a done validate_prior job", async () => {
    const raw = createTestDb();
    const ownerId = ensureOwnerUser(raw);
    const now = new Date().toISOString();
    raw.prepare(`INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (1, ?, 'x', 'confirmed', ?, ?)`).run(ownerId, now, now);
    raw.prepare(
      `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, confirmed_at)
       VALUES (1, ?, 1, 'Prompt 1', 'x', 'literal', ?, 'h', 'confirmed', 1, 'hyp', 'kill', ?)`
    ).run(ownerId, JSON.stringify(SPEC), now);
    raw.prepare(`INSERT INTO watchlists (watchlist_id, user_id, prompt_id, name, created_at) VALUES (1, ?, 1, 'wl', ?)`).run(ownerId, now);

    let lastBar = "2026-10-02";
    const tickerFor = (asOf: string) => `T${asOf.replace(/-/g, "")}`; // a fresh full_match each week
    const plusDays = (iso: string, d: number) => { const x = new Date(`${iso}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };
    const fetchFn = vi.fn().mockImplementation(async (url: string, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      const ok = (b: unknown) => ({ ok: true, text: async () => JSON.stringify(b) });
      if (url.endsWith("/health")) return ok({ status: "ok", last_bar_date: lastBar });
      if (url.endsWith("/arms/register")) return ok({ prompt_id: 1, status: "active" });
      const pick = { ticker: tickerFor(body.as_of), membership: "full_match", values: {}, failed_ids: [], ep: 100, sl: 95, r: 0.05 };
      if (url.endsWith("/screen")) return ok({ candidates: [pick], applied_steps: [], funnel: [], sector_view: [] });
      if (url.endsWith("/select")) return ok({ entered: [{ ...pick, entry_price: 100 }], not_confirmed: [], no_point_data: [], watching: [] });
      if (url.endsWith("/validate")) {
        const rows = (body.picks as { ticker: string }[]).flatMap((p) =>
          [1, 2, 3].flatMap((h) =>
            (["signal", "trade"] as const).map((view) => {
              const matured = plusDays(body.as_of, 7 * h) <= lastBar;
              return { ticker: p.ticker, signal_week_start: body.as_of, horizon_weeks: h, view, status: matured ? "graded" : "pending", buy_price: 100, r_Nw: matured ? h * (view === "trade" ? 1 : 10) : null };
            })
          )
        );
        // The engine's own 13-week maturity gate is treated as already passed
        // here — this test is about horizon maturity, not that gate.
        return ok({ graded_weeks: body.graded_weeks_so_far, maturity: "first_look", rows });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const validationsFor = (asOf: string) =>
      raw.prepare("SELECT v.horizon_w, v.n, v.ew_return FROM validations v JOIN runs r ON r.run_id = v.run_id WHERE r.as_of = ? ORDER BY v.horizon_w").all(asOf);
    const validateJob = (asOf: string) =>
      (raw.prepare("SELECT status FROM jobs WHERE type = 'validate_prior' AND prompt_id = 1 AND as_of = ?").get(asOf) as { status: string } | undefined)?.status;

    // Week 1 (the confirm-time run): screened and entered, nothing gradable yet.
    const { runId: firstRunId } = await runWeeklyScreen(raw, { promptId: 1, asOf: "2026-10-02", kind: "catch_up" }, fetchFn as any);
    await runSelectEntry(raw, { promptId: 1, runId: firstRunId }, fetchFn as any);
    await runCatchUp(raw, { promptId: 1 }, fetchFn as any);
    expect(validationsFor("2026-10-02")).toEqual([]);

    // Week 2: run 10-02's horizon 1 has matured — and only horizon 1, from the trade view only.
    lastBar = "2026-10-09";
    expect((await runCatchUp(raw, { promptId: 1 }, fetchFn as any)).weeksRun).toEqual(["2026-10-09"]);
    expect(validationsFor("2026-10-02")).toEqual([{ horizon_w: 1, n: 1, ew_return: 1 }]);
    expect(validationsFor("2026-10-09")).toEqual([]);
    expect(validateJob("2026-10-02")).toBe("queued"); // horizons 2/3 still pending -> retryable

    // Week 3: 10-02 gains horizon 2, 10-09 gains horizon 1.
    lastBar = "2026-10-16";
    await runCatchUp(raw, { promptId: 1 }, fetchFn as any);
    expect(validationsFor("2026-10-02").map((v: any) => v.horizon_w)).toEqual([1, 2]);
    expect(validationsFor("2026-10-09")).toEqual([{ horizon_w: 1, n: 1, ew_return: 1 }]);

    // Week 4: 10-02 is fully graded -> its job is done.
    lastBar = "2026-10-23";
    await runCatchUp(raw, { promptId: 1 }, fetchFn as any);
    expect(validationsFor("2026-10-02")).toEqual([
      { horizon_w: 1, n: 1, ew_return: 1 },
      { horizon_w: 2, n: 1, ew_return: 2 },
      { horizon_w: 3, n: 1, ew_return: 3 },
    ]);
    expect(validateJob("2026-10-02")).toBe("done");

    // A second catch-up with no new bar: still-pending runs are retried, but
    // the done 10-02 job is skipped — no /validate call for it at all.
    fetchFn.mockClear();
    expect((await runCatchUp(raw, { promptId: 1 }, fetchFn as any)).weeksRun).toEqual([]);
    const validatedAsOfs = validateCallAsOfs(fetchFn);
    expect(validatedAsOfs).not.toContain("2026-10-02");
    expect(validatedAsOfs).toEqual(["2026-10-09", "2026-10-16"]);
    expect(validateJob("2026-10-02")).toBe("done");
  });

  it("retries a failed validate_prior job on the next catch-up", async () => {
    const raw = createTestDb();
    seedPromptWithOneRun(raw, "2026-10-02");
    await runCatchUp(raw, { promptId: 1 }, fetchWithValidateFailure() as any);
    expect(raw.prepare("SELECT status FROM jobs WHERE type = 'validate_prior' AND as_of = '2026-10-02'").get()).toEqual({ status: "failed" });

    const okFetch = fakeFetch();
    const { gradingFailures } = await runCatchUp(raw, { promptId: 1 }, okFetch as any);
    expect(gradingFailures).toEqual([]);
    // Attempted (and failed) during both week 10-09's and week 10-16's
    // catch-up, then succeeded on this retry.
    expect(raw.prepare("SELECT status, attempts FROM jobs WHERE type = 'validate_prior' AND as_of = '2026-10-02'").get()).toEqual({ status: "done", attempts: 3 });
  });

  // --- Final-review I2: arm registration is retried on every catch-up.
  it("re-registers the prompt's arm with its spec on every catch-up", async () => {
    const raw = createTestDb();
    seedPromptWithOneRun(raw, "2026-10-16");
    const fetchFn = fakeFetch();
    const { armRegistrationError } = await runCatchUp(raw, { promptId: 1 }, fetchFn as any);
    expect(armRegistrationError).toBeNull();
    const registerCalls = fetchFn.mock.calls.filter(([url]: any[]) => String(url).endsWith("/arms/register"));
    expect(registerCalls).toHaveLength(1);
    expect(JSON.parse(registerCalls[0][1].body)).toEqual({ prompt_id: 1, spec: SPEC });
  });

  it("still screens, selects and grades the week when arm registration fails, and reports the failure", async () => {
    const raw = createTestDb();
    seedPromptWithOneRun(raw, "2026-10-02");
    const ok = fakeFetch();
    const fetchFn = vi.fn().mockImplementation(async (url: string, init?: unknown) => {
      if (url.endsWith("/arms/register")) throw new Error("register engine down");
      return ok(url, init);
    });
    const { weeksRun, armRegistrationError } = await runCatchUp(raw, { promptId: 1 }, fetchFn as any);
    expect(armRegistrationError).toBe("register engine down");
    expect(weeksRun).toEqual(["2026-10-09", "2026-10-16"]);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'validate_prior'").get()).toEqual({ n: 2 });
  });

  it("never re-registers (re-activates) the arm of a retired prompt", async () => {
    const raw = createTestDb();
    seedPromptWithOneRun(raw, "2026-10-16");
    raw.prepare("UPDATE prompts SET status = 'retired', closed_at = '2026-10-17' WHERE prompt_id = 1").run();
    const fetchFn = fakeFetch();
    await runCatchUp(raw, { promptId: 1 }, fetchFn as any);
    expect(fetchFn.mock.calls.some(([url]: any[]) => String(url).endsWith("/arms/register"))).toBe(false);
  });
});
