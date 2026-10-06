import type Database from "better-sqlite3";

// The prompt's latest run that has at least one validations row — the single
// definition of "latest graded run", shared by getValidationSummary (the
// watchlist's validation card) and listPrompts (My prompts' 1-week return) so
// the two screens can never disagree. Most runs have no validations row yet
// (grading happens weeks later, as horizons mature), so "latest run by
// run_id" is NOT a substitute.
export function latestGradedRunId(raw: Database.Database, promptId: number): number | null {
  const row = raw
    .prepare(
      `SELECT r.run_id FROM runs r
       WHERE r.prompt_id = ? AND EXISTS (SELECT 1 FROM validations v WHERE v.run_id = r.run_id)
       ORDER BY r.as_of DESC LIMIT 1`
    )
    .get(promptId) as { run_id: number } | undefined;
  return row ? row.run_id : null;
}

export function getValidationSummary(raw: Database.Database, promptId: number) {
  const gradedWeeks = (
    raw.prepare("SELECT COUNT(*) AS n FROM runs WHERE prompt_id = ? AND kind IN ('scheduled','catch_up')").get(promptId) as { n: number }
  ).n;

  const latestGradedRun = latestGradedRunId(raw, promptId);

  if (latestGradedRun === null) return { gradedWeeks, horizons: [] };

  const horizons = (
    raw.prepare("SELECT horizon_w, n, ew_return, hit_rate FROM validations WHERE run_id = ? ORDER BY horizon_w").all(latestGradedRun) as any[]
  ).map((row) => ({ horizon: row.horizon_w, n: row.n, ewReturn: row.ew_return, hitRate: row.hit_rate }));

  return { gradedWeeks, horizons };
}
