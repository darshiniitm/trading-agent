import type Database from "better-sqlite3";

export function getWatchlistView(raw: Database.Database, watchlistId: number) {
  const watchlist = raw.prepare("SELECT * FROM watchlists WHERE watchlist_id = ?").get(watchlistId) as any;
  if (!watchlist) return null;

  const prompt = raw.prepare("SELECT * FROM prompts WHERE prompt_id = ?").get(watchlist.prompt_id) as any;
  const spec = JSON.parse(prompt.spec_json);

  const conditions = (raw.prepare("SELECT * FROM prompt_conditions WHERE prompt_id = ? ORDER BY cond_no").all(prompt.prompt_id) as any[]).map(
    (c) => ({
      condNo: c.cond_no, role: c.role, kind: c.kind, name: c.name,
      params: c.params_json ? JSON.parse(c.params_json) : null,
      op: c.op, value: c.value_json ? JSON.parse(c.value_json) : null,
      valueOrigin: c.value_origin,
    })
  );

  const lastRunRow = raw
    .prepare("SELECT * FROM runs WHERE prompt_id = ? ORDER BY run_id DESC LIMIT 1")
    .get(prompt.prompt_id) as any;
  const lastRun = lastRunRow
    ? { runId: lastRunRow.run_id, asOf: lastRunRow.as_of, appliedSteps: JSON.parse(lastRunRow.applied_steps_json ?? "[]") }
    : null;

  // Prepared once and reused for every row below, never inside the .map()
  // callback: see the identical fix (and its comment) in confirm.ts — the
  // same native crash reproduced here against a real 93-entry watchlist.
  const selectRunResult = raw.prepare(
    "SELECT cond_json, failed_conds_json FROM run_results WHERE run_id = ? AND symbol = ?"
  );
  const entries = (raw
    .prepare("SELECT * FROM watchlist_entries WHERE watchlist_id = ? ORDER BY symbol")
    .all(watchlistId) as any[]).map((e) => {
    const result = selectRunResult.get(e.last_run_id, e.symbol) as any;
    return {
      entryId: e.entry_id, symbol: e.symbol, membership: e.membership, status: e.status,
      entryPrice: e.entry_price, stop: e.stop, refPrice: e.ref_price,
      condValues: result ? JSON.parse(result.cond_json) : {},
      failedIds: result?.failed_conds_json ? JSON.parse(result.failed_conds_json) : [],
    };
  });

  return {
    watchlistId: watchlist.watchlist_id, promptId: prompt.prompt_id, title: prompt.title,
    structure: prompt.structure, hypothesis: prompt.hypothesis, killCriterion: prompt.kill_criterion,
    conditions, hasRiskCap: spec.risk_cap_pct !== null && spec.risk_cap_pct !== undefined,
    lastRun, entries,
  };
}
