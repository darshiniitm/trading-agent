import type Database from "better-sqlite3";
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
): Promise<{ maturity: string; gradedWeeks: number }> {
  const prompt = raw.prepare("SELECT * FROM prompts WHERE prompt_id = ?").get(promptId) as any;
  if (!prompt) throw new Error(`prompt ${promptId} not found`);
  const run = raw.prepare("SELECT * FROM runs WHERE run_id = ? AND prompt_id = ?").get(runId, promptId) as any;
  if (!run) throw new Error(`run ${runId} not found for prompt ${promptId}`);
  const spec = JSON.parse(prompt.spec_json);

  const gradedWeeksSoFar = (
    raw
      .prepare(`SELECT COUNT(*) AS n FROM runs WHERE prompt_id = ? AND kind IN ('scheduled','catch_up') AND as_of <= ?`)
      .get(promptId, run.as_of) as { n: number }
  ).n;

  const owner = raw.prepare("SELECT watchlist_id FROM watchlists WHERE prompt_id = ? AND user_id = ?").get(promptId, prompt.owner_user_id) as { watchlist_id: number } | undefined;
  const picks = owner
    ? (raw
        .prepare("SELECT symbol, entry_price, stop FROM watchlist_entries WHERE watchlist_id = ? AND first_run_id = ? AND status = 'entered'")
        .all(owner.watchlist_id, runId) as { symbol: string; entry_price: number | null; stop: number | null }[])
    : [];

  const result = await validateArm(
    promptId, spec, run.as_of,
    picks.map((p) => ({ ticker: p.symbol, entry_price: p.entry_price, sl: p.stop })),
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

  return { maturity: result.maturity, gradedWeeks: result.graded_weeks };
}
