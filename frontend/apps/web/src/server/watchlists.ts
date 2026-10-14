import type Database from "better-sqlite3";
import { hasRiskCap, programOf } from "@/server/programOf";
import { getValidationSummary, getValidationCaptions } from "@/server/validations";
import { storedConditionLabel } from "@/lib/conditionLabel";

const humanise = (step: string) => { const t = step.replace(/_/g, " "); return t.charAt(0).toUpperCase() + t.slice(1); };

// "What runs": the steps the last run applied (on) plus the trade-plan parts the prompt did not set (off).
function whatRunsOf(program: any, appliedSteps: { step: string; applied: boolean }[]) {
  const items = appliedSteps.map((s) => ({ label: humanise(s.step), on: !!s.applied }));
  if (!hasRiskCap(program)) items.push({ label: "Risk cap: not in prompt", on: false });
  return items;
}

export function getWatchlistView(raw: Database.Database, watchlistId: number, viewerUserId?: number) {
  const watchlist = raw.prepare("SELECT * FROM watchlists WHERE watchlist_id = ?").get(watchlistId) as any;
  if (!watchlist) return null;

  const prompt = raw.prepare("SELECT * FROM prompts WHERE prompt_id = ?").get(watchlist.prompt_id) as any;
  const program = programOf(prompt.spec_json);

  const conditions = (raw.prepare("SELECT * FROM prompt_conditions WHERE prompt_id = ? ORDER BY cond_no").all(prompt.prompt_id) as any[]).map(
    (c) => ({
      condNo: c.cond_no, role: c.role, kind: c.kind, name: c.name,
      params: c.params_json ? JSON.parse(c.params_json) : null,
      op: c.op, value: c.value_json ? JSON.parse(c.value_json) : null,
      valueOrigin: c.value_origin,
    })
  ).map((c) => ({ ...c, label: storedConditionLabel(c) }));

  const lastRunRow = raw
    .prepare("SELECT * FROM runs WHERE prompt_id = ? ORDER BY run_id DESC LIMIT 1")
    .get(prompt.prompt_id) as any;
  const lastRun = lastRunRow
    ? { runId: lastRunRow.run_id, asOf: lastRunRow.as_of, appliedSteps: JSON.parse(lastRunRow.applied_steps_json ?? "[]") }
    : null;

  // Prepared once and reused for every row below, never inside the .map()
  // callback: see the identical fix (and its comment) in confirm.ts — the
  // same native crash reproduced here against a real 93-entry watchlist.
  const selectSymbol = raw.prepare("SELECT name, sector FROM symbols WHERE symbol = ?");
  const selectRunAsOf = raw.prepare("SELECT as_of FROM runs WHERE run_id = ?");
  const selectRunResult = raw.prepare(
    "SELECT cond_json, failed_conds_json FROM run_results WHERE run_id = ? AND symbol = ?"
  );
  const entries = (raw
    .prepare("SELECT * FROM watchlist_entries WHERE watchlist_id = ? ORDER BY symbol")
    .all(watchlistId) as any[]).map((e) => {
    const result = selectRunResult.get(e.last_run_id, e.symbol) as any;
    const sym = selectSymbol.get(e.symbol) as any;
    const added = selectRunAsOf.get(e.first_run_id) as any;
    return {
      name: sym?.name ?? null, sector: sym?.sector ?? null, addedAsOf: added?.as_of ?? null, entryDate: e.entry_date ?? null,
      entryId: e.entry_id, symbol: e.symbol, membership: e.membership, status: e.status,
      entryPrice: e.entry_price, stop: e.stop, refPrice: e.ref_price,
      condValues: result ? JSON.parse(result.cond_json) : {},
      failedIds: result?.failed_conds_json ? JSON.parse(result.failed_conds_json) : [],
    };
  });

  const validation = { ...getValidationSummary(raw, prompt.prompt_id), ...getValidationCaptions(raw, prompt.prompt_id) };

  const owner = raw.prepare("SELECT display_name FROM users WHERE user_id = ?").get(prompt.owner_user_id) as any;
  const followers = (raw.prepare("SELECT COUNT(*) AS n FROM watchlists WHERE prompt_id = ? AND user_id <> ? AND archived_at IS NULL").get(prompt.prompt_id, prompt.owner_user_id) as { n: number }).n;
  const tradePlan = (program.actions as any[]).find((a) => a.type === "trade_plan");

  return {
    watchlistId: watchlist.watchlist_id, promptId: prompt.prompt_id, title: prompt.title,
    structure: prompt.structure, hypothesis: prompt.hypothesis, killCriterion: prompt.kill_criterion,
    conditions, hasRiskCap: hasRiskCap(program),
    lastRun, entries, validation,
    promptText: prompt.prompt_text, draftId: prompt.draft_id, ownerName: owner?.display_name ?? "", isOwner: (viewerUserId ?? watchlist.user_id) === prompt.owner_user_id,
    visibility: prompt.visibility ?? "private", followers, version: prompt.version, parentPromptId: prompt.parent_prompt_id ?? null,
    confirmedAt: prompt.confirmed_at, timeframe: (program as any).timeframe ?? null, entryAt: tradePlan?.entry?.at ?? null,
    whatRuns: whatRunsOf(program, lastRun?.appliedSteps ?? []),
  };
}
