import type { Db } from "./db/pg";
import { latestGradedRunId } from "@/server/validations";

export async function listPrompts(raw: Db, { userId, view }: { userId: number; view: "mine" | "drafts" | "following" }) {
  if (view === "drafts") {
    return (await raw.all("SELECT * FROM prompt_drafts WHERE user_id = ? AND status != 'confirmed' ORDER BY updated_at DESC", [userId])).map((d) => {
      let blockedReason: string | null = null;
      if (!d.program_json) blockedReason = "not interpreted yet";
      else if (!d.hypothesis || !d.kill_criterion) blockedReason = "missing hypothesis/kill criterion";
      return { draftId: d.draft_id, title: d.title, lastEditedAt: d.updated_at, blockedReason, promptText: String(d.prompt_text ?? "").slice(0, 120) };
    });
  }

  if (view === "following") {
    const rows = await raw.all(`SELECT p.prompt_id, p.title, u.display_name AS owner_name
      FROM watchlists w JOIN prompts p ON p.prompt_id = w.prompt_id JOIN users u ON u.user_id = p.owner_user_id
      WHERE w.user_id = ? AND p.owner_user_id <> ? AND w.archived_at IS NULL ORDER BY p.prompt_id DESC`, [userId, userId]);
    const out = [];
    for (const row of rows) {
      const graded = await raw.get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE prompt_id = ? AND kind IN ('scheduled','catch_up')", [row.prompt_id]);
      const run = await raw.get<{ run_id: number }>("SELECT run_id FROM runs WHERE prompt_id = ? ORDER BY run_id DESC LIMIT 1", [row.prompt_id]);
      const value = run ? await raw.get<{ ew_return: number; control_ew_return: number | null }>("SELECT ew_return, control_ew_return FROM validations WHERE run_id = ? AND horizon_w = 1", [run.run_id]) : undefined;
      out.push({ promptId: row.prompt_id, title: row.title, ownerName: row.owner_name, gradedWeeks: graded!.n, lastHorizon1Return: value?.ew_return ?? null, lastHorizon1Control: value?.control_ew_return ?? null });
    }
    return out;
  }

  const prompts = await raw.all("SELECT * FROM prompts WHERE owner_user_id = ? ORDER BY prompt_id DESC", [userId]);
  const out = [];
  for (const p of prompts) {
    const gradedWeeks = (await raw.get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE prompt_id = ? AND kind IN ('scheduled','catch_up')", [p.prompt_id]))!.n;
    const gradedRunId = await latestGradedRunId(raw, p.prompt_id);
    const validation = gradedRunId !== null
      ? await raw.get<{ ew_return: number; control_ew_return: number | null }>("SELECT ew_return, control_ew_return FROM validations WHERE run_id = ? AND horizon_w = 1", [gradedRunId])
      : undefined;
    // The owner's own watchlist for this prompt — never assume watchlist_id ==
    // prompt_id (they only coincide while every prompt has exactly one list).
    const watchlist = await raw.get<{ watchlist_id: number }>("SELECT watchlist_id FROM watchlists WHERE prompt_id = ? AND user_id = ?", [p.prompt_id, p.owner_user_id]);
    const followers = (await raw.get<{ n: number }>("SELECT COUNT(*) AS n FROM watchlists WHERE prompt_id = ? AND user_id <> ? AND archived_at IS NULL", [p.prompt_id, p.owner_user_id]))!.n;
    out.push({
      promptId: p.prompt_id, title: p.title, structure: p.structure, status: p.status,
      version: p.version, parentPromptId: p.parent_prompt_id, gradedWeeks,
      lastHorizon1Return: validation ? validation.ew_return : null, lastHorizon1Control: validation?.control_ew_return ?? null,
      followers,
      watchlistId: watchlist ? watchlist.watchlist_id : null, visibility: p.visibility ?? "private",
    });
  }
  return out;
}
