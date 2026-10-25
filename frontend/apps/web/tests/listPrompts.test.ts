import { program } from "./helpers/program";
import { describe, expect, it } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { listPrompts } from "@/server/listPrompts";
import { saveProgramState, createDraft, updateDraft } from "@/server/drafts";
import { getValidationSummary } from "@/server/validations";
import { prep } from "./helpers/prep";
import type { Db } from "@/server/db/pg";

async function seedTwoPrompts(raw: Db) {
  const ownerId = await ensureOwnerUser(raw);
  const now = new Date().toISOString();
  for (const [promptId, version, parent, status] of [[1, 1, null, "superseded"], [2, 2, 1, "confirmed"]] as const) {
    await prep(raw, `INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (?, ?, 'x', 'confirmed', ?, ?)`).run(promptId, ownerId, now, now);
    await prep(raw, 
      `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, parent_prompt_id, version, hypothesis, kill_criterion, confirmed_at)
       VALUES (?, ?, ?, 'T', 'x', 'literal', '{}', ?, ?, ?, ?, 'h', 'k', ?)`
    ).run(promptId, ownerId, promptId, `hash${promptId}`, status, parent, version, now);
    await prep(raw, `INSERT INTO runs (prompt_id, as_of, kind, status, finished_at) VALUES (?, '2026-10-02', 'scheduled', 'done', ?)`).run(promptId, now);
  }
  await prep(raw, `INSERT INTO validations (run_id, horizon_w, n, ew_return, hit_rate, computed_at) VALUES (2, 1, 5, 3.2, 0.6, ?)`).run(now);
  return { ownerId };
}

describe("listPrompts — view mine", () => {
  it("returns every owned prompt with its version chain and latest 1-week validation", async () => {
    const raw = await createTestDb();
    const { ownerId } = await seedTwoPrompts(raw);
    const rows = await listPrompts(raw, { userId: ownerId, view: "mine" }) as any[];
    const v2 = rows.find((r) => r.promptId === 2);
    expect(v2).toMatchObject({ parentPromptId: 1, version: 2, status: "confirmed", gradedWeeks: 1, lastHorizon1Return: 3.2 });
    const v1 = rows.find((r) => r.promptId === 1);
    expect(v1).toMatchObject({ status: "superseded", lastHorizon1Return: null });
  });
});

describe("listPrompts — view mine, final-review I5/I6", () => {
  async function seedPrompt(raw: Db, ownerId: number, promptId: number) {
    const now = new Date().toISOString();
    await prep(raw, `INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (?, ?, 'x', 'confirmed', ?, ?)`).run(promptId, ownerId, now, now);
    await prep(raw, 
      `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, confirmed_at)
       VALUES (?, ?, ?, 'T', 'x', 'literal', '{}', ?, 'confirmed', 1, 'h', 'k', ?)`
    ).run(promptId, ownerId, promptId, `hash${promptId}`, now);
  }

  it("reports the 1-week return of the latest run that HAS a validation — the same run getValidationSummary shows", async () => {
    const raw = await createTestDb();
    const ownerId = await ensureOwnerUser(raw);
    await seedPrompt(raw, ownerId, 1);
    const now = new Date().toISOString();
    const runIds: number[] = [];
    for (const asOf of ["2026-10-02", "2026-10-09", "2026-10-16"]) {
      runIds.push((await prep(raw, `INSERT INTO runs (prompt_id, as_of, kind, status, finished_at) VALUES (1, ?, 'catch_up', 'done', ?)`).run(asOf, now)).lastInsertRowid);
    }
    // Only the oldest run is graded so far; the two newer runs have no validations yet.
    await prep(raw, `INSERT INTO validations (run_id, horizon_w, n, ew_return, hit_rate, computed_at) VALUES (?, 1, 3, 1.75, 0.66, ?)`).run(runIds[0], now);

    const [row] = await listPrompts(raw, { userId: ownerId, view: "mine" }) as any[];
    expect(row.lastHorizon1Return).toBe(1.75);
    const summary = await getValidationSummary(raw, 1);
    expect(summary.horizons.find((h: any) => h.horizon === 1)?.ewReturn).toBe(row.lastHorizon1Return);
  });

  it("returns the owner's actual watchlistId, which need not equal promptId", async () => {
    const raw = await createTestDb();
    const ownerId = await ensureOwnerUser(raw);
    await seedPrompt(raw, ownerId, 1);
    await seedPrompt(raw, ownerId, 2);
    const now = new Date().toISOString();
    await prep(raw, `INSERT INTO watchlists (watchlist_id, user_id, prompt_id, name, created_at) VALUES (40, ?, 2, 'wl', ?)`).run(ownerId, now);
    await prep(raw, `INSERT INTO watchlists (watchlist_id, user_id, prompt_id, name, created_at) VALUES (41, ?, 1, 'wl', ?)`).run(ownerId, now);

    const rows = await listPrompts(raw, { userId: ownerId, view: "mine" }) as any[];
    expect(rows.find((r) => r.promptId === 1).watchlistId).toBe(41);
    expect(rows.find((r) => r.promptId === 2).watchlistId).toBe(40);
  });
});

describe("listPrompts — view drafts", () => {
  it("flags a draft that has not been interpreted yet as blocked", async () => {
    const raw = await createTestDb();
    const userId = await ensureOwnerUser(raw);
    const { draftId } = await createDraft(raw, { userId });
    const rows = await listPrompts(raw, { userId, view: "drafts" }) as any[];
    expect(rows).toEqual([expect.objectContaining({ draftId, blockedReason: "not interpreted yet" })]);
  });

  it("flags a draft missing hypothesis/kill criterion, once it has a program", async () => {
    const raw = await createTestDb();
    const userId = await ensureOwnerUser(raw);
    const { draftId } = await createDraft(raw, { userId });
    await saveProgramState(raw, draftId, { program: program(), clauses: [], normalised: "" });
    const rows = await listPrompts(raw, { userId, view: "drafts" }) as any[];
    expect(rows[0].blockedReason).toBe("missing hypothesis/kill criterion");
  });

  it("reports blockedReason null once a draft is ready to confirm", async () => {
    const raw = await createTestDb();
    const userId = await ensureOwnerUser(raw);
    const { draftId } = await createDraft(raw, { userId });
    await saveProgramState(raw, draftId, { program: program(), clauses: [], normalised: "" });
    await updateDraft(raw, draftId, { hypothesis: "h", killCriterion: "k" });
    const rows = await listPrompts(raw, { userId, view: "drafts" }) as any[];
    expect(rows[0].blockedReason).toBeNull();
  });
});
