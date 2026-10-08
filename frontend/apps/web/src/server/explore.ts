import type Database from "better-sqlite3";
import { storedConditionLabel } from "@/lib/conditionLabel";

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
  const result = rows.map((row) => ({ conditionLabels: (conds.all(row.prompt_id) as any[]).map((c) => storedConditionLabel({ name: c.name, params: c.params_json ? JSON.parse(c.params_json) : null, op: c.op, value: c.value_json ? JSON.parse(c.value_json) : null })), promptId: row.prompt_id, title: row.title, structure: row.structure, ownerName: row.owner_name, isMine: row.owner_user_id === userId, followers: (followers.get(row.prompt_id, row.owner_user_id) as any).n, gradedWeeks: (graded.get(row.prompt_id) as any).n, isFollowing: Boolean(following.get(row.prompt_id, userId)) }));
  if (sort === "followers") result.sort((a, b) => b.followers - a.followers);
  else if (sort === "graded_weeks") result.sort((a, b) => b.gradedWeeks - a.gradedWeeks);
  else result.sort((a, b) => b.promptId - a.promptId);
  return result;
}
