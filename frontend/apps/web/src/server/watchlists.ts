import type { Db } from "./db/pg";
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

export async function getWatchlistView(raw: Db, watchlistId: number, viewerUserId?: number) {
  const watchlist = await raw.get("SELECT * FROM watchlists WHERE watchlist_id = ?", [watchlistId]);
  if (!watchlist) return null;

  const prompt = (await raw.get("SELECT * FROM prompts WHERE prompt_id = ?", [watchlist.prompt_id]))!;
  const program = programOf(prompt.spec_json);

  const conditions = (await raw.all("SELECT * FROM prompt_conditions WHERE prompt_id = ? ORDER BY cond_no", [prompt.prompt_id])).map(
    (c) => ({
      condNo: c.cond_no, role: c.role, kind: c.kind, name: c.name,
      params: c.params_json ? JSON.parse(c.params_json) : null,
      op: c.op, value: c.value_json ? JSON.parse(c.value_json) : null,
      valueOrigin: c.value_origin,
    })
  ).map((c) => ({ ...c, label: storedConditionLabel(c) }));

  const lastRunRow = await raw.get("SELECT * FROM runs WHERE prompt_id = ? ORDER BY run_id DESC LIMIT 1", [prompt.prompt_id]);
  const lastRun = lastRunRow
    ? { runId: lastRunRow.run_id, asOf: lastRunRow.as_of, appliedSteps: JSON.parse(lastRunRow.applied_steps_json ?? "[]") }
    : null;

  // One joined read for every row (symbol info, the run it was added in, its latest run result) instead of
  // three round trips per entry.
  const entries = (await raw.all(
    `SELECT e.*, s.name AS sym_name, s.sector AS sym_sector, r.as_of AS added_as_of, rr.cond_json, rr.failed_conds_json
       FROM watchlist_entries e
       LEFT JOIN symbols s ON s.symbol = e.symbol
       LEFT JOIN runs r ON r.run_id = e.first_run_id
       LEFT JOIN run_results rr ON rr.run_id = e.last_run_id AND rr.symbol = e.symbol
      WHERE e.watchlist_id = ? ORDER BY e.symbol`, [watchlistId])).map((e) => ({
    name: e.sym_name ?? null, sector: e.sym_sector ?? null, addedAsOf: e.added_as_of ?? null, entryDate: e.entry_date ?? null,
    entryId: e.entry_id, symbol: e.symbol, membership: e.membership, status: e.status,
    entryPrice: e.entry_price, stop: e.stop, refPrice: e.ref_price,
    condValues: e.cond_json ? JSON.parse(e.cond_json) : {},
    failedIds: e.failed_conds_json ? JSON.parse(e.failed_conds_json) : [],
  }));

  const validation = { ...(await getValidationSummary(raw, prompt.prompt_id)), ...(await getValidationCaptions(raw, prompt.prompt_id)) };

  const owner = await raw.get("SELECT display_name FROM users WHERE user_id = ?", [prompt.owner_user_id]);
  const followers = (await raw.get<{ n: number }>("SELECT COUNT(*) AS n FROM watchlists WHERE prompt_id = ? AND user_id <> ? AND archived_at IS NULL", [prompt.prompt_id, prompt.owner_user_id]))!.n;
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
