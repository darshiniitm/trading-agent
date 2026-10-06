import type Database from "better-sqlite3";
import { latestGradedRunId } from "@/server/validations";

export function listPrompts(raw: Database.Database, { userId, view }: { userId: number; view: "mine" | "drafts" }) {
  if (view === "drafts") {
    return (raw.prepare("SELECT * FROM prompt_drafts WHERE user_id = ? AND status != 'confirmed' ORDER BY updated_at DESC").all(userId) as any[]).map((d) => {
      let blockedReason: string | null = null;
      if (!d.structure || !d.spec_json) blockedReason = "no spec yet";
      else if (!d.hypothesis || !d.kill_criterion) blockedReason = "missing hypothesis/kill criterion";
      return { draftId: d.draft_id, title: d.title, lastEditedAt: d.updated_at, blockedReason };
    });
  }

  const prompts = raw.prepare("SELECT * FROM prompts WHERE owner_user_id = ? ORDER BY prompt_id DESC").all(userId) as any[];
  const selectGradedWeeks = raw.prepare("SELECT COUNT(*) AS n FROM runs WHERE prompt_id = ? AND kind IN ('scheduled','catch_up')");
  const selectHorizon1 = raw.prepare("SELECT ew_return FROM validations WHERE run_id = ? AND horizon_w = 1");
  // The owner's own watchlist for this prompt — never assume watchlist_id ==
  // prompt_id (they only coincide while every prompt has exactly one list).
  const selectOwnerWatchlist = raw.prepare("SELECT watchlist_id FROM watchlists WHERE prompt_id = ? AND user_id = ?");

  return prompts.map((p) => {
    const gradedWeeks = (selectGradedWeeks.get(p.prompt_id) as { n: number }).n;
    const gradedRunId = latestGradedRunId(raw, p.prompt_id);
    const validation = gradedRunId !== null ? (selectHorizon1.get(gradedRunId) as { ew_return: number } | undefined) : undefined;
    const watchlist = selectOwnerWatchlist.get(p.prompt_id, p.owner_user_id) as { watchlist_id: number } | undefined;
    return {
      promptId: p.prompt_id, title: p.title, structure: p.structure, status: p.status,
      version: p.version, parentPromptId: p.parent_prompt_id, gradedWeeks,
      lastHorizon1Return: validation ? validation.ew_return : null,
      watchlistId: watchlist ? watchlist.watchlist_id : null,
    };
  });
}
