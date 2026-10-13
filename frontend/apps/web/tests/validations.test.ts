import { describe, expect, it } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { getValidationSummary } from "@/server/validations";

function seedPromptWithGradedAndUngradedRuns(raw: ReturnType<typeof createTestDb>) {
  const ownerId = ensureOwnerUser(raw);
  const now = new Date().toISOString();
  raw.prepare(`INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (1, ?, 'x', 'confirmed', ?, ?)`).run(ownerId, now, now);
  raw.prepare(
    `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, confirmed_at)
     VALUES (1, ?, 1, 'T', 'x', 'literal', '{}', 'h', 'confirmed', 1, 'h', 'k', ?)`
  ).run(ownerId, now);
  raw.prepare(`INSERT INTO runs (run_id, prompt_id, as_of, kind, status, finished_at) VALUES (10, 1, '2026-10-02', 'scheduled', 'done', ?)`).run(now);
  raw.prepare(`INSERT INTO runs (run_id, prompt_id, as_of, kind, status, finished_at) VALUES (11, 1, '2026-10-09', 'scheduled', 'done', ?)`).run(now);
  raw.prepare(`INSERT INTO validations (run_id, horizon_w, n, ew_return, hit_rate, computed_at) VALUES (10, 1, 5, 2.0, 0.6, ?)`).run(now);
  raw.prepare(`INSERT INTO validations (run_id, horizon_w, n, ew_return, hit_rate, computed_at) VALUES (10, 2, 5, 1.0, 0.4, ?)`).run(now);
  return { ownerId };
}

describe("getValidationSummary", () => {
  it("returns the latest graded run's per-horizon numbers, not the latest (possibly ungraded) run", () => {
    const raw = createTestDb();
    seedPromptWithGradedAndUngradedRuns(raw);
    const summary = getValidationSummary(raw, 1);
    expect(summary.gradedWeeks).toBe(2);
    expect(summary.horizons).toEqual([
      { horizon: 1, n: 5, ewReturn: 2.0, hitRate: 0.6 },
      { horizon: 2, n: 5, ewReturn: 1.0, hitRate: 0.4 },
    ]);
  });

  it("returns an empty horizons array with the right gradedWeeks when nothing is graded yet", () => {
    const raw = createTestDb();
    const ownerId = ensureOwnerUser(raw);
    const now = new Date().toISOString();
    raw.prepare(`INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (1, ?, 'x', 'confirmed', ?, ?)`).run(ownerId, now, now);
    raw.prepare(
      `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, confirmed_at)
       VALUES (1, ?, 1, 'T', 'x', 'literal', '{}', 'h', 'confirmed', 1, 'h', 'k', ?)`
    ).run(ownerId, now);
    raw.prepare(`INSERT INTO runs (run_id, prompt_id, as_of, kind, status, finished_at) VALUES (10, 1, '2026-10-02', 'scheduled', 'done', ?)`).run(now);
    const summary = getValidationSummary(raw, 1);
    expect(summary).toEqual({ gradedWeeks: 1, horizons: [] });
  });
});
