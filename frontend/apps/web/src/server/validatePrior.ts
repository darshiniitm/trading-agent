import type Database from "better-sqlite3";
import { programOf } from "@/server/programOf";
import { validateArm, type ValidateRow } from "@/server/engine/client";

// The one engine view a validations row is built from: "trade" (trailing-stop
// exit) — the realistic, actionable number for a forward-testing program, and
// the project's own primary view (src/backtest/horizons.py). The "signal" view
// rows the engine also returns are deliberately ignored here, never averaged in.
export const VALIDATION_VIEW = "trade" as const;

function aggregate(rows: ValidateRow[], horizon: number): { n: number; ewReturn: number; hitRate: number } | null {
  const graded = rows.filter(
    (r) => r.view === VALIDATION_VIEW && r.horizon_weeks === horizon && r.status === "graded" && r.r_Nw !== null
  );
  if (graded.length === 0) return null;
  const n = graded.length;
  const ewReturn = graded.reduce((sum, r) => sum + (r.r_Nw as number), 0) / n;
  const hitRate = graded.filter((r) => (r.r_Nw as number) > 0).length / n;
  return { n, ewReturn, hitRate };
}

export async function runValidatePrior(
  raw: Database.Database,
  { promptId, runId }: { promptId: number; runId: number },
  fetchFn?: typeof fetch
): Promise<{ maturity: string; gradedWeeks: number; complete: boolean }> {
  const prompt = raw.prepare("SELECT * FROM prompts WHERE prompt_id = ?").get(promptId) as any;
  if (!prompt) throw new Error(`prompt ${promptId} not found`);
  const run = raw.prepare("SELECT * FROM runs WHERE run_id = ? AND prompt_id = ?").get(runId, promptId) as any;
  if (!run) throw new Error(`run ${runId} not found for prompt ${promptId}`);
  // Partial and low-coverage runs stay visible but are excluded from forward-test scoring (data-fallback spec §7).
  if (run.scored === 0) return { maturity: "not_first_look", gradedWeeks: 0, complete: true };
  const program = programOf(prompt.spec_json);

  const gradedWeeksSoFar = (
    raw
      .prepare(`SELECT COUNT(*) AS n FROM runs WHERE prompt_id = ? AND kind IN ('scheduled','catch_up') AND as_of <= ? AND (scored IS NULL OR scored = 1)`)
      .get(promptId, run.as_of) as { n: number }
  ).n;

  // Sourced from run_results, not watchlist_entries (N1 fix): run_results is
  // one immutable row per (run_id, symbol), never reused across runs, so it
  // correctly distinguishes a symbol entered on THIS run from a frozen
  // watchlist_entries row left over from an earlier run (not_confirmed, or
  // entered-then-dropped-then-requalified). watchlist_entries rows freeze
  // once status reaches 'entered'/'not_confirmed' (weeklyScreen.ts
  // FROZEN_STATUSES) and so cannot be trusted to reflect which run a pick's
  // entry actually belongs to. run_results is also per-PROMPT rather than
  // per-watchlist — the arm's forward record is about the prompt's own
  // picks, not any one user's watchlist view of them — so this also drops
  // validatePrior's dependency on the owner's watchlist entirely.
  const picks = raw
    .prepare("SELECT symbol, entry_price, sl FROM run_results WHERE run_id = ? AND entry_status = 'entered'")
    .all(runId) as { symbol: string; entry_price: number | null; sl: number | null }[];

  const result = await validateArm(
    promptId, program, run.as_of,
    picks.map((p) => ({ ticker: p.symbol, entry_price: p.entry_price, sl: p.sl })),
    gradedWeeksSoFar, fetchFn
  );

  if (result.maturity !== "not_first_look") {
    const now = new Date().toISOString();
    const upsert = raw.prepare(
      `INSERT INTO validations (run_id, horizon_w, n, ew_return, control_ew_return, hit_rate, computed_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT (run_id, horizon_w) DO UPDATE SET n = excluded.n, ew_return = excluded.ew_return, hit_rate = excluded.hit_rate, computed_at = excluded.computed_at`
    );
    for (const horizon of [1, 2, 3]) {
      const agg = aggregate(result.rows, horizon);
      if (agg) upsert.run(runId, horizon, agg.n, agg.ewReturn, agg.hitRate, now);
    }
  }

  // Complete = nothing left to grade for this run, ever: either the engine's
  // maturity gate returned no rows (gradedWeeksSoFar is fixed per run — it
  // counts runs up to this run's own as_of — so a retry would get the same
  // answer), or no row is still "pending" (every horizon has its bar).
  // An incomplete result keeps the validate_prior job retryable.
  const complete = result.maturity === "not_first_look" || !result.rows.some((r) => r.status === "pending");
  return { maturity: result.maturity, gradedWeeks: result.graded_weeks, complete };
}
