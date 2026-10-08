import type Database from "better-sqlite3";
import { storedConditionLabel } from "@/lib/conditionLabel";
import { latestGradedRunId } from "@/server/validations";

export function listExplore(raw: Database.Database, { userId, structure, usesCondition, sort }: { userId: number; structure?: string; usesCondition?: string; sort?: "followers" | "graded_weeks" }) {
  let sql = `SELECT p.prompt_id, p.title, p.structure, p.owner_user_id, p.visibility, u.display_name AS owner_name
             FROM prompts p JOIN users u ON u.user_id = p.owner_user_id
             WHERE p.visibility = 'shared' AND p.status = 'confirmed'`;
  const params: unknown[] = [];
  if (structure) { sql += " AND p.structure = ?"; params.push(structure); }
  if (usesCondition) { sql += " AND EXISTS (SELECT 1 FROM prompt_conditions pc WHERE pc.prompt_id = p.prompt_id AND pc.name = ?)"; params.push(usesCondition); }
  const rows = raw.prepare(sql).all(...params) as any[];
  const followers = raw.prepare("SELECT COUNT(*) AS n FROM watchlists WHERE prompt_id = ? AND user_id <> ? AND archived_at IS NULL");
  const graded = raw.prepare("SELECT COUNT(*) AS n FROM runs WHERE prompt_id = ? AND kind IN ('scheduled','catch_up')");
  const following = raw.prepare("SELECT 1 FROM watchlists WHERE prompt_id = ? AND user_id = ? AND archived_at IS NULL");
  const conds = raw.prepare("SELECT name, params_json, op, value_json FROM prompt_conditions WHERE prompt_id = ? ORDER BY cond_no");
  const h1 = raw.prepare("SELECT ew_return, control_ew_return FROM validations WHERE run_id = ? AND horizon_w = 1");
  const ownList = raw.prepare("SELECT watchlist_id FROM watchlists WHERE prompt_id = ? AND user_id = ?");
  const vsControl = (promptId: number) => {
    const run = latestGradedRunId(raw, promptId);
    const v = run === null ? undefined : (h1.get(run) as { ew_return: number | null; control_ew_return: number | null } | undefined);
    return v && v.ew_return !== null && v.control_ew_return !== null ? v.ew_return - v.control_ew_return : null;
  };
  const result = rows.map((row) => ({ vsControl: vsControl(row.prompt_id), watchlistId: row.owner_user_id === userId ? ((ownList.get(row.prompt_id, userId) as any)?.watchlist_id ?? null) : null, conditionLabels: (conds.all(row.prompt_id) as any[]).map((c) => storedConditionLabel({ name: c.name, params: c.params_json ? JSON.parse(c.params_json) : null, op: c.op, value: c.value_json ? JSON.parse(c.value_json) : null })), promptId: row.prompt_id, title: row.title, structure: row.structure, ownerName: row.owner_name, isMine: row.owner_user_id === userId, followers: (followers.get(row.prompt_id, row.owner_user_id) as any).n, gradedWeeks: (graded.get(row.prompt_id) as any).n, isFollowing: Boolean(following.get(row.prompt_id, userId)) }));
  if (sort === "followers") result.sort((a, b) => b.followers - a.followers);
  else if (sort === "graded_weeks") result.sort((a, b) => b.gradedWeeks - a.gradedWeeks);
  else result.sort((a, b) => b.promptId - a.promptId);
  return result;
}
