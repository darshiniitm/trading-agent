import { describe, expect, it } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { listPrompts } from "@/server/listPrompts";
import { createDraft, updateDraft } from "@/server/drafts";

function seedTwoPrompts(raw: ReturnType<typeof createTestDb>) {
  const ownerId = ensureOwnerUser(raw);
  const now = new Date().toISOString();
  for (const [promptId, version, parent, status] of [[1, 1, null, "superseded"], [2, 2, 1, "confirmed"]] as const) {
    raw.prepare(`INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (?, ?, 'x', 'confirmed', ?, ?)`).run(promptId, ownerId, now, now);
    raw.prepare(
      `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, parent_prompt_id, version, hypothesis, kill_criterion, confirmed_at)
       VALUES (?, ?, ?, 'T', 'x', 'literal', '{}', ?, ?, ?, ?, 'h', 'k', ?)`
    ).run(promptId, ownerId, promptId, `hash${promptId}`, status, parent, version, now);
    raw.prepare(`INSERT INTO runs (prompt_id, as_of, kind, status, finished_at) VALUES (?, '2026-10-02', 'scheduled', 'done', ?)`).run(promptId, now);
  }
  raw.prepare(`INSERT INTO validations (run_id, horizon_w, n, ew_return, hit_rate, computed_at) VALUES (2, 1, 5, 3.2, 0.6, ?)`).run(now);
  return { ownerId };
}

describe("listPrompts — view mine", () => {
  it("returns every owned prompt with its version chain and latest 1-week validation", () => {
    const raw = createTestDb();
    const { ownerId } = seedTwoPrompts(raw);
    const rows = listPrompts(raw, { userId: ownerId, view: "mine" }) as any[];
    const v2 = rows.find((r) => r.promptId === 2);
    expect(v2).toMatchObject({ parentPromptId: 1, version: 2, status: "confirmed", gradedWeeks: 1, lastHorizon1Return: 3.2 });
    const v1 = rows.find((r) => r.promptId === 1);
    expect(v1).toMatchObject({ status: "superseded", lastHorizon1Return: null });
  });
});

describe("listPrompts — view drafts", () => {
  it("flags a draft with no spec yet as blocked", () => {
    const raw = createTestDb();
    const userId = ensureOwnerUser(raw);
    const { draftId } = createDraft(raw, { userId });
    const rows = listPrompts(raw, { userId, view: "drafts" }) as any[];
    expect(rows).toEqual([expect.objectContaining({ draftId, blockedReason: "no spec yet" })]);
  });

  it("flags a draft missing hypothesis/kill criterion, once it has a spec", () => {
    const raw = createTestDb();
    const userId = ensureOwnerUser(raw);
    const { draftId } = createDraft(raw, { userId });
    updateDraft(raw, draftId, { structure: "literal", specJson: JSON.stringify({ spec_version: 4, structure: "literal", timeframe: "1W", selection_point: null, conditions: [], stop: null, risk_cap_pct: null, near_miss: null }) });
    const rows = listPrompts(raw, { userId, view: "drafts" }) as any[];
    expect(rows[0].blockedReason).toBe("missing hypothesis/kill criterion");
  });

  it("reports blockedReason null once a draft is ready to confirm", () => {
    const raw = createTestDb();
    const userId = ensureOwnerUser(raw);
    const { draftId } = createDraft(raw, { userId });
    updateDraft(raw, draftId, {
      structure: "literal",
      specJson: JSON.stringify({ spec_version: 4, structure: "literal", timeframe: "1W", selection_point: null, conditions: [], stop: null, risk_cap_pct: null, near_miss: null }),
      hypothesis: "h", killCriterion: "k",
    });
    const rows = listPrompts(raw, { userId, view: "drafts" }) as any[];
    expect(rows[0].blockedReason).toBeNull();
  });
});
