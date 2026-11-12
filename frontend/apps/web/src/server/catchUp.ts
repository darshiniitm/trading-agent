import type { Db } from "@/server/db/pg";
import { programOf } from "@/server/programOf";
import { getHealth, registerArm } from "@/server/engine/client";
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
async function lastCompleteAsOf(raw: Db, promptId: number): Promise<string> {
  const lastDoneCatchUpJob = await raw.get<{ as_of: string }>(
    `SELECT as_of FROM jobs WHERE type = 'catch_up' AND prompt_id = ? AND status = 'done' AND as_of IS NOT NULL ORDER BY as_of DESC LIMIT 1`,
    [promptId]);
  if (lastDoneCatchUpJob) return lastDoneCatchUpJob.as_of;

  const lastRun = await raw.get<{ as_of: string }>(
    `SELECT as_of FROM runs WHERE prompt_id = ? AND kind <> 'dry_run' ORDER BY as_of DESC LIMIT 1`, [promptId]);
  if (!lastRun) throw new Error(`prompt ${promptId} has no runs yet`);
  return lastRun.as_of;
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// How far back from a given week to look for runs whose 1-/2-/3-week horizon
// may have just matured: 3 weeks for horizon 3, plus one week of slack for
// bar dates that drift off the 7-day grid (holiday weeks, a confirm-time run
// dated on a non-Friday bar, a data lag of a few days).
const VALIDATE_LOOKBACK_DAYS = 28;

// Grades every earlier run of this prompt within the lookback window, each as
// its own idempotent validate_prior job keyed by that run's as_of:
//  - a run already fully graded (job 'done') is skipped without an engine call;
//  - a run with horizons still pending stays 'queued' and is graded again on a
//    later week (so horizon 2/3 get written once their bars exist);
//  - a run whose grading threw is recorded 'failed' (with the error) on its
//    jobs row and retried next time — it never blocks the weekly cycle.
// Never grades the reference week's own run: its horizons can't have matured.
async function gradeMaturedRuns(
  raw: Db,
  promptId: number,
  referenceAsOf: string,
  fetchFn: typeof fetch | undefined,
  failures: string[]
): Promise<void> {
  const runs = await raw.all<{ run_id: number; as_of: string }>(
    `SELECT run_id, as_of FROM runs
     WHERE prompt_id = ? AND kind <> 'dry_run' AND as_of >= ? AND as_of < ?
     ORDER BY as_of`,
    [promptId, addDays(referenceAsOf, -VALIDATE_LOOKBACK_DAYS), referenceAsOf]);

  for (const run of runs) {
    try {
      await withJob(
        raw,
        { type: "validate_prior", promptId, asOf: run.as_of },
        () => runValidatePrior(raw, { promptId, runId: run.run_id }, fetchFn),
        { isComplete: (r) => r.complete }
      );
    } catch (err) {
      failures.push(`${run.as_of}: ${(err as Error).message}`);
    }
  }
}

export async function runCatchUp(
  raw: Db,
  { promptId }: { promptId: number },
  fetchFn?: typeof fetch
): Promise<{ weeksRun: string[]; gradingFailures: string[]; armRegistrationError: string | null }> {
  const anchorAsOf = await lastCompleteAsOf(raw, promptId);

  // Self-healing arm registration: confirmDraft registers the arm once, and a
  // failure there used to be permanent — the engine's is_active(prompt_id)
  // gate then never lets /select write a forward record for this prompt. The
  // engine's register_arm is an idempotent upsert, so re-assert it on every
  // catch-up. Only for a still-confirmed prompt: registering would flip a
  // retired/superseded prompt's arm back to active. Best-effort — a failure
  // here never blocks the week's screen/select/grading.
  const prompt = await raw.get<{ status: string; spec_json: string }>("SELECT status, spec_json FROM prompts WHERE prompt_id = ?", [promptId]);
  let armRegistrationError: string | null = null;
  if (prompt && prompt.status === "confirmed") {
    try {
      await registerArm(promptId, programOf(prompt.spec_json), fetchFn);
    } catch (err) {
      armRegistrationError = (err as Error).message;
    }
  }

  const health = (await getHealth(fetchFn)) as { last_bar_date: string | null };
  if (!health.last_bar_date) return { weeksRun: [], gradingFailures: [], armRegistrationError };

  const missedWeeks = fridaysBetweenExclusiveInclusive(anchorAsOf, health.last_bar_date);
  const weeksRun: string[] = [];
  const gradingFailures: string[] = [];

  for (const asOf of missedWeeks) {
    const { skipped, result } = await withJob(raw, { type: "catch_up", promptId, asOf }, async () => {
      // A retry of a week whose runSelectEntry (or later) step previously
      // threw must not re-call runWeeklyScreen: it already committed a
      // `runs` row for (promptId, asOf) on the earlier attempt, and
      // `ux_runs_graded` (UNIQUE on (prompt_id, as_of) WHERE kind <>
      // 'dry_run') would reject a second insert. Reuse that row instead.
      const existingRun = await raw.get<{ run_id: number }>(`SELECT run_id FROM runs WHERE prompt_id = ? AND as_of = ? AND kind <> 'dry_run'`, [promptId, asOf]);

      const runId = existingRun
        ? existingRun.run_id
        : (await runWeeklyScreen(raw, { promptId, asOf, kind: "catch_up" }, fetchFn)).runId;

      await runSelectEntry(raw, { promptId, runId }, fetchFn);
      return runId;
    });
    if (!skipped && result !== null) weeksRun.push(asOf);

    // Grading is its own per-run job (validate_prior), outside the catch_up
    // job: it grades EARLIER runs whose horizons matured by this week, not
    // this week's brand-new run (whose future bars don't exist yet).
    await gradeMaturedRuns(raw, promptId, asOf, fetchFn, gradingFailures);
  }

  // Nothing new to screen (already caught up): still retry any grading that
  // is pending or failed, against the engine's latest bar.
  if (missedWeeks.length === 0) {
    await gradeMaturedRuns(raw, promptId, health.last_bar_date, fetchFn, gradingFailures);
  }

  return { weeksRun, gradingFailures, armRegistrationError };
}
