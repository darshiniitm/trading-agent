import type Database from "better-sqlite3";
import { latestGradedRunId } from "@/server/validations";

export function listPrompts(raw: Database.Database, { userId, view }: { userId: number; view: "mine" | "drafts" | "following" }) {
  if (view === "drafts") {
    return (raw.prepare("SELECT * FROM prompt_drafts WHERE user_id = ? AND status != 'confirmed' ORDER BY updated_at DESC").all(userId) as any[]).map((d) => {
      let blockedReason: string | null = null;
      if (!d.program_json) blockedReason = "not interpreted yet";
      else if (!d.hypothesis || !d.kill_criterion) blockedReason = "missing hypothesis/kill criterion";
      return { draftId: d.draft_id, title: d.title, lastEditedAt: d.updated_at, blockedReason, promptText: String(d.prompt_text ?? "").slice(0, 120) };
    });
  }

  if (view === "following") {
    const rows = raw.prepare(`SELECT p.prompt_id, p.title, u.display_name AS owner_name
      FROM watchlists w JOIN prompts p ON p.prompt_id = w.prompt_id JOIN users u ON u.user_id = p.owner_user_id
      WHERE w.user_id = ? AND p.owner_user_id <> ? AND w.archived_at IS NULL ORDER BY p.prompt_id DESC`).all(userId, userId) as any[];
    const graded = raw.prepare("SELECT COUNT(*) AS n FROM runs WHERE prompt_id = ? AND kind IN ('scheduled','catch_up')");
    const latest = raw.prepare("SELECT run_id FROM runs WHERE prompt_id = ? ORDER BY run_id DESC LIMIT 1");
    const horizon = raw.prepare("SELECT ew_return, control_ew_return FROM validations WHERE run_id = ? AND horizon_w = 1");
    return rows.map((row) => {
      const run = latest.get(row.prompt_id) as { run_id: number } | undefined;
      const value = run ? horizon.get(run.run_id) as { ew_return: number; control_ew_return: number | null } | undefined : undefined;
      return { promptId: row.prompt_id, title: row.title, ownerName: row.owner_name, gradedWeeks: (graded.get(row.prompt_id) as any).n, lastHorizon1Return: value?.ew_return ?? null, lastHorizon1Control: value?.control_ew_return ?? null };
    });
  }

  const prompts = raw.prepare("SELECT * FROM prompts WHERE owner_user_id = ? ORDER BY prompt_id DESC").all(userId) as any[];
  const selectGradedWeeks = raw.prepare("SELECT COUNT(*) AS n FROM runs WHERE prompt_id = ? AND kind IN ('scheduled','catch_up')");
  const selectHorizon1 = raw.prepare("SELECT ew_return, control_ew_return FROM validations WHERE run_id = ? AND horizon_w = 1");
  const selectFollowers = raw.prepare("SELECT COUNT(*) AS n FROM watchlists WHERE prompt_id = ? AND user_id <> ? AND archived_at IS NULL");
  // The owner's own watchlist for this prompt — never assume watchlist_id ==
  // prompt_id (they only coincide while every prompt has exactly one list).
  const selectOwnerWatchlist = raw.prepare("SELECT watchlist_id FROM watchlists WHERE prompt_id = ? AND user_id = ?");

  return prompts.map((p) => {
    const gradedWeeks = (selectGradedWeeks.get(p.prompt_id) as { n: number }).n;
    const gradedRunId = latestGradedRunId(raw, p.prompt_id);
    const validation = gradedRunId !== null ? (selectHorizon1.get(gradedRunId) as { ew_return: number; control_ew_return: number | null } | undefined) : undefined;
    const watchlist = selectOwnerWatchlist.get(p.prompt_id, p.owner_user_id) as { watchlist_id: number } | undefined;
    return {
      promptId: p.prompt_id, title: p.title, structure: p.structure, status: p.status,
      version: p.version, parentPromptId: p.parent_prompt_id, gradedWeeks,
      lastHorizon1Return: validation ? validation.ew_return : null, lastHorizon1Control: validation?.control_ew_return ?? null,
      followers: (selectFollowers.get(p.prompt_id, p.owner_user_id) as { n: number }).n,
      watchlistId: watchlist ? watchlist.watchlist_id : null, visibility: p.visibility ?? "private",
    };
  });
}
