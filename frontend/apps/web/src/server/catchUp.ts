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

export async function runCatchUp(
  raw: Database.Database,
  { promptId }: { promptId: number },
  fetchFn?: typeof fetch
): Promise<{ weeksRun: string[] }> {
  const lastRun = raw.prepare("SELECT as_of FROM runs WHERE prompt_id = ? ORDER BY as_of DESC LIMIT 1").get(promptId) as { as_of: string } | undefined;
  if (!lastRun) throw new Error(`prompt ${promptId} has no runs yet`);

  const health = await getHealth(fetchFn);
  if (!health.last_bar_date) return { weeksRun: [] };

  const missedWeeks = fridaysBetweenExclusiveInclusive(lastRun.as_of, health.last_bar_date);
  const weeksRun: string[] = [];

  for (const asOf of missedWeeks) {
    const { skipped, result } = await withJob(raw, { type: "catch_up", promptId, asOf }, async () => {
      const { runId } = await runWeeklyScreen(raw, { promptId, asOf, kind: "catch_up" }, fetchFn);
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
