import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { runCatchUp } from "@/server/catchUp";

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

function fakeFetch() {
  return vi.fn().mockImplementation(async (url: string) => {
    if (url.endsWith("/health")) return { ok: true, text: async () => JSON.stringify({ status: "ok", engine_git_sha: "abc", last_bar_date: "2026-10-16", data_snapshot_hash: null }) };
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
});
