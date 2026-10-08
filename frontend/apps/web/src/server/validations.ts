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

// Captions for the validation tiles: the graded run's as_of and, for each horizon, the Friday-close date it
// becomes due (as_of + horizon weeks). Kept apart from getValidationSummary so that function's shape is stable.
export function getValidationCaptions(raw: Database.Database, promptId: number) {
  const runId = latestGradedRunId(raw, promptId) ?? (raw.prepare("SELECT run_id FROM runs WHERE prompt_id = ? AND kind IN ('scheduled','catch_up') ORDER BY as_of DESC LIMIT 1").get(promptId) as { run_id: number } | undefined)?.run_id;
  if (runId === undefined) return { gradedAsOf: null as string | null, dueDates: {} as Record<string, string>, controls: {} as Record<string, number | null> };
  const asOf = (raw.prepare("SELECT as_of FROM runs WHERE run_id = ?").get(runId) as { as_of: string }).as_of;
  const dueDates: Record<string, string> = {};
  for (const h of [1, 2, 3]) {
    const d = new Date(`${asOf}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 7 * h);
    dueDates[String(h)] = d.toISOString().slice(0, 10);
  }
  const controls: Record<string, number | null> = {};
  for (const row of raw.prepare("SELECT horizon_w, control_ew_return FROM validations WHERE run_id = ?").all(runId) as any[]) controls[String(row.horizon_w)] = row.control_ew_return;
  return { gradedAsOf: asOf, dueDates, controls };
}
