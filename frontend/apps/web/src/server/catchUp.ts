import type Database from "better-sqlite3";
import { getHealth } from "@/server/engine/client";
import { runWeeklyScreen } from "@/server/weeklyScreen";
import { runSelectEntry } from "@/server/selectEntry";
import { runValidatePrior } from "@/server/validatePrior";
import { withJob } from "@/server/jobs";

function fridaysBetweenExclusiveInclusive(lastAsOf: string, lastBarDate: string): string[] {
  const out: string[] = [];
  let d = new Date(`${lastAsOf}T00:00:00Z`);
  const end = new Date(`${lastBarDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 7);
  while (d.getTime() <= end.getTime()) {
    out.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime());
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return out;
}

// The anchor to walk forward from: the latest week a catch_up job actually
// completed end-to-end (screen + select + validate-best-effort), per the
// jobs table — NOT the latest `runs` row, because runWeeklyScreen commits
// its `runs` row as soon as its own transaction finishes, before
// runSelectEntry/runValidatePrior even run. Using `runs` directly would
// treat a week whose runSelectEntry subsequently threw as "fully handled"
// and never retry it. Only when no catch_up job has ever completed for
// this prompt (e.g. right after confirm, before the first catch-up ever
// ran) do we fall back to the latest `runs.as_of` — the confirm-time run.
function lastCompleteAsOf(raw: Database.Database, promptId: number): string {
  const lastDoneCatchUpJob = raw
    .prepare(
      `SELECT as_of FROM jobs WHERE type = 'catch_up' AND prompt_id = ? AND status = 'done' AND as_of IS NOT NULL ORDER BY as_of DESC LIMIT 1`
    )
    .get(promptId) as { as_of: string } | undefined;
  if (lastDoneCatchUpJob) return lastDoneCatchUpJob.as_of;

  const lastRun = raw
    .prepare(`SELECT as_of FROM runs WHERE prompt_id = ? AND kind <> 'dry_run' ORDER BY as_of DESC LIMIT 1`)
    .get(promptId) as { as_of: string } | undefined;
  if (!lastRun) throw new Error(`prompt ${promptId} has no runs yet`);
  return lastRun.as_of;
}

export async function runCatchUp(
  raw: Database.Database,
  { promptId }: { promptId: number },
  fetchFn?: typeof fetch
): Promise<{ weeksRun: string[] }> {
  const anchorAsOf = lastCompleteAsOf(raw, promptId);

  const health = (await getHealth(fetchFn)) as { last_bar_date: string | null };
  if (!health.last_bar_date) return { weeksRun: [] };

  const missedWeeks = fridaysBetweenExclusiveInclusive(anchorAsOf, health.last_bar_date);
  const weeksRun: string[] = [];

  for (const asOf of missedWeeks) {
    const { skipped, result } = await withJob(raw, { type: "catch_up", promptId, asOf }, async () => {
      // A retry of a week whose runSelectEntry (or later) step previously
      // threw must not re-call runWeeklyScreen: it already committed a
      // `runs` row for (promptId, asOf) on the earlier attempt, and
      // `ux_runs_graded` (UNIQUE on (prompt_id, as_of) WHERE kind <>
      // 'dry_run') would reject a second insert. Reuse that row instead.
      const existingRun = raw
        .prepare(`SELECT run_id FROM runs WHERE prompt_id = ? AND as_of = ? AND kind <> 'dry_run'`)
        .get(promptId, asOf) as { run_id: number } | undefined;

      const runId = existingRun
        ? existingRun.run_id
        : (await runWeeklyScreen(raw, { promptId, asOf, kind: "catch_up" }, fetchFn)).runId;

      await runSelectEntry(raw, { promptId, runId }, fetchFn);
      try {
        await runValidatePrior(raw, { promptId, runId }, fetchFn);
      } catch {
        // validate_prior failing never blocks catch-up from moving to the
        // next week — grading can always be retried later once the weekly
        // run itself is safely recorded.
      }
      return runId;
    });
    if (!skipped && result !== null) weeksRun.push(asOf);
  }

  return { weeksRun };
}
