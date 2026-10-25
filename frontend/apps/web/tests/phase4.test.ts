import { describe, expect, it } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { setVisibility } from "@/server/visibility";
import { followPrompt, unfollowPrompt } from "@/server/follow";
import { copyPromptToDraft } from "@/server/copyPrompt";
import { listExplore } from "@/server/explore";
import { prep } from "./helpers/prep";
import type { Db } from "@/server/db/pg";


async function seedPrompt(raw: Db, visibility: "private" | "shared" = "shared", promptId = 15, draftId = 1, runId = 1) {
  const ownerId = await ensureOwnerUser(raw);
  await prep(raw, "INSERT OR IGNORE INTO users (user_id, display_name, email, role, status, created_at) VALUES (2, 'Follower', 'follower@example.com', 'member', 'active', '2026-01-01')").run();
  const spec = '{"spec_version":4,"structure":"literal","timeframe":"1W","selection_point":null,"conditions":[],"stop":null,"risk_cap_pct":null,"near_miss":null}';
  await prep(raw, "INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, structure, spec_json, hypothesis, kill_criterion, status, created_at, updated_at) VALUES (?, ?, 'source text', 'literal', ?, 'hyp', 'kill', 'confirmed', '2026-01-01', '2026-01-01')").run(draftId, ownerId, spec);
  await prep(raw, "INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, visibility, confirmed_at) VALUES (?, ?, ?, 'Shared prompt', 'source text', 'literal', ?, ?, 'confirmed', 1, 'hyp', 'kill', ?, '2026-01-01')").run(promptId, ownerId, draftId, spec, `hash${promptId}`, visibility);
  await prep(raw, "INSERT INTO prompt_conditions (prompt_id, cond_no, role, kind, name, params_json, op, value_json, value_origin) VALUES (?, 1, 'filter', 'field', 'mcap_cr', '{}', '>=', '100', 'prompt')").run(promptId);
  await prep(raw, "INSERT INTO runs (run_id, prompt_id, as_of, kind, status) VALUES (?, ?, '2026-01-01', 'catch_up', 'done')").run(runId, promptId);
  await prep(raw, "INSERT OR IGNORE INTO symbols (symbol, active) VALUES ('ABC', 1)").run();
  await prep(raw, "INSERT INTO run_results (run_id, symbol, membership, in_forward_record, cond_json, entry_status) VALUES (?, 'ABC', 'full_match', 0, '{}', 'pending_selection')").run(runId);
  return { ownerId, followerId: 2 };
}

describe("Phase 4 sharing", () => {
  it("archives follower watchlists when a shared prompt becomes private", async () => {
    const raw = await createTestDb(); const { ownerId, followerId } = await seedPrompt(raw, "shared");
    const { watchlistId } = await followPrompt(raw, { promptId: 15, userId: followerId });
    await setVisibility(raw, { promptId: 15, userId: ownerId, visibility: "private" });
    expect((await prep(raw, "SELECT archived_at FROM watchlists WHERE watchlist_id = ?").get(watchlistId) as any).archived_at).not.toBeNull();
    await expect(followPrompt(raw, { promptId: 15, userId: followerId })).rejects.toThrow(/private/);
  });

  it("reuses an archived watchlist and seeds it from the latest run", async () => {
    const raw = await createTestDb(); const { followerId } = await seedPrompt(raw, "shared");
    const first = await followPrompt(raw, { promptId: 15, userId: followerId });
    await unfollowPrompt(raw, { promptId: 15, userId: followerId });
    const second = await followPrompt(raw, { promptId: 15, userId: followerId });
    expect(second.watchlistId).toBe(first.watchlistId);
    expect((await prep(raw, "SELECT COUNT(*) AS n FROM watchlist_entries WHERE watchlist_id = ?").get(first.watchlistId) as any).n).toBe(1);
  });

  it("returns only shared prompts and supports condition and follower sorting", async () => {
    const raw = await createTestDb(); const { ownerId, followerId } = await seedPrompt(raw, "shared");
    await seedPrompt(raw, "private", 16, 2, 2);
    await followPrompt(raw, { promptId: 15, userId: followerId });
    const rows = await listExplore(raw, { userId: ownerId, usesCondition: "mcap_cr", sort: "followers" });
    expect(rows.map((row) => row.promptId)).toEqual([15]);
    expect(rows[0].followers).toBe(1);
  });

  it("copies an accessible prompt into a new draft with lineage", async () => {
    const raw = await createTestDb(); const { followerId } = await seedPrompt(raw, "shared");
    const { draftId } = await copyPromptToDraft(raw, { promptId: 15, userId: followerId });
    const row = await prep(raw, "SELECT user_id, copied_from_prompt_id, prompt_text, program_json FROM prompt_drafts WHERE draft_id = ?").get(draftId) as any;
    expect(row.user_id).toBe(followerId); expect(row.copied_from_prompt_id).toBe(15); expect(row.prompt_text).toBe("source text"); expect(JSON.parse(row.program_json).program_version).toBe(5);   // a v4 source spec is upgraded when copied
  });
});

describe("listExplore condition labels (G8)", () => {
  it("returns the prompt's condition labels for the card chips", async () => {
    const raw = await createTestDb(); const { ownerId } = await seedPrompt(raw, "shared");
    expect((await listExplore(raw, { userId: ownerId }))[0].conditionLabels).toEqual(["Market cap (cr) · ≥ 100"]);
  });
});

describe("listExplore vs-control and own watchlist", () => {
  it("is null without a graded run, and carries the owner's own watchlist id", async () => {
    const raw = await createTestDb(); const { ownerId } = await seedPrompt(raw, "shared");
    await prep(raw, "INSERT INTO watchlists (watchlist_id, user_id, prompt_id, name, created_at) VALUES (9, ?, 15, 'w', now())").run(ownerId);
    const row = (await listExplore(raw, { userId: ownerId }))[0];
    expect(row.vsControl).toBeNull();
    expect(row.watchlistId).toBe(9);
    await prep(raw, "INSERT INTO validations (run_id, horizon_w, n, ew_return, control_ew_return, hit_rate, computed_at) VALUES (1, 1, 3, 2.5, 1.0, 0.5, now())").run();
    expect((await listExplore(raw, { userId: ownerId }))[0].vsControl).toBeCloseTo(1.5);
  });
});
