import type { Db } from "./db/pg";
import { storedConditionLabel } from "@/lib/conditionLabel";
import { latestGradedRunId } from "@/server/validations";

export async function listExplore(raw: Db, { userId, structure, usesCondition, sort }: { userId: number; structure?: string; usesCondition?: string; sort?: "followers" | "graded_weeks" }) {
  let sql = `SELECT p.prompt_id, p.title, p.structure, p.owner_user_id, p.visibility, u.display_name AS owner_name
             FROM prompts p JOIN users u ON u.user_id = p.owner_user_id
             WHERE p.visibility = 'shared' AND p.status = 'confirmed'`;
  const params: unknown[] = [];
  if (structure) { sql += " AND p.structure = ?"; params.push(structure); }
  if (usesCondition) { sql += " AND EXISTS (SELECT 1 FROM prompt_conditions pc WHERE pc.prompt_id = p.prompt_id AND pc.name = ?)"; params.push(usesCondition); }
  const rows = await raw.all(sql, params);
  const result = [];
  for (const row of rows) {
    const run = await latestGradedRunId(raw, row.prompt_id);
    const v = run === null ? undefined : await raw.get<{ ew_return: number | null; control_ew_return: number | null }>("SELECT ew_return, control_ew_return FROM validations WHERE run_id = ? AND horizon_w = 1", [run]);
    const vsControl = v && v.ew_return !== null && v.control_ew_return !== null ? v.ew_return - v.control_ew_return : null;
    const watchlistId = row.owner_user_id === userId ? ((await raw.get<{ watchlist_id: number }>("SELECT watchlist_id FROM watchlists WHERE prompt_id = ? AND user_id = ?", [row.prompt_id, userId]))?.watchlist_id ?? null) : null;
    const conds = await raw.all("SELECT name, params_json, op, value_json FROM prompt_conditions WHERE prompt_id = ? ORDER BY cond_no", [row.prompt_id]);
    result.push({
      vsControl, watchlistId,
      conditionLabels: conds.map((c) => storedConditionLabel({ name: c.name, params: c.params_json ? JSON.parse(c.params_json) : null, op: c.op, value: c.value_json ? JSON.parse(c.value_json) : null })),
      promptId: row.prompt_id, title: row.title, structure: row.structure, ownerName: row.owner_name, isMine: row.owner_user_id === userId,
      followers: (await raw.get<{ n: number }>("SELECT COUNT(*) AS n FROM watchlists WHERE prompt_id = ? AND user_id <> ? AND archived_at IS NULL", [row.prompt_id, row.owner_user_id]))!.n,
      gradedWeeks: (await raw.get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE prompt_id = ? AND kind IN ('scheduled','catch_up')", [row.prompt_id]))!.n,
      isFollowing: Boolean(await raw.get("SELECT 1 FROM watchlists WHERE prompt_id = ? AND user_id = ? AND archived_at IS NULL", [row.prompt_id, userId])),
    });
  }
  if (sort === "followers") result.sort((a, b) => b.followers - a.followers);
  else if (sort === "graded_weeks") result.sort((a, b) => b.gradedWeeks - a.gradedWeeks);
  else result.sort((a, b) => b.promptId - a.promptId);
  return result;
}
