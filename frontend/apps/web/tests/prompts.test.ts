import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { createEditDraft, retirePrompt } from "@/server/prompts";
import { getDraft } from "@/server/drafts";
import { prep } from "./helpers/prep";
import type { Db } from "@/server/db/pg";

const SPEC = {
  spec_version: 4, structure: "literal" as const, timeframe: "1W" as const,
  selection_point: { session_of_week: 1, at: "open" as const },
  conditions: [], stop: null, risk_cap_pct: null, near_miss: null,
};

async function seedConfirmedPrompt(raw: Db, status = "confirmed") {
  const ownerId = await ensureOwnerUser(raw);
  const now = new Date().toISOString();
  await prep(raw, `INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (1, ?, 'x', 'confirmed', ?, ?)`).run(ownerId, now, now);
  await prep(raw, 
    `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, confirmed_at)
     VALUES (1, ?, 1, 'Prompt 1', 'the original brief', 'literal', ?, 'h', ?, 1, 'hyp', 'kill', ?)`
  ).run(ownerId, JSON.stringify(SPEC), status, now);
  return { ownerId };
}

describe("createEditDraft", () => {
  it("creates a new open draft parented to the confirmed prompt, pre-filled with its spec", async () => {
    const raw = await createTestDb();
    const { ownerId } = await seedConfirmedPrompt(raw);
    const { draftId } = await createEditDraft(raw, { promptId: 1, userId: ownerId });
    const draft = (await getDraft(raw, draftId))!;
    expect(draft.status).toBe("open");
    expect(draft.program).toMatchObject({ program_version: 5, universe: { source: "nse_all" } });
    expect(draft.program!.sets[0].where).toEqual({ all: [] });   // the stored v4 spec, upgraded on read
    expect(draft.hypothesis).toBe("hyp");
    const row = await prep(raw, "SELECT parent_prompt_id, prompt_text FROM prompt_drafts WHERE draft_id = ?").get(draftId) as any;
    expect(row.parent_prompt_id).toBe(1);
    expect(row.prompt_text).toBe("the original brief");
  });

  it("refuses to edit an already-superseded prompt", async () => {
    const raw = await createTestDb();
    const { ownerId } = await seedConfirmedPrompt(raw, "superseded");
    await expect(createEditDraft(raw, { promptId: 1, userId: ownerId })).rejects.toThrow(/already superseded/);
  });

  it("refuses to edit an already-retired prompt", async () => {
    const raw = await createTestDb();
    const { ownerId } = await seedConfirmedPrompt(raw, "retired");
    await expect(createEditDraft(raw, { promptId: 1, userId: ownerId })).rejects.toThrow(/already retired/);
  });
});

describe("retirePrompt", () => {
  it("marks the prompt retired and calls the engine's retire endpoint", async () => {
    const raw = await createTestDb();
    await seedConfirmedPrompt(raw);
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ prompt_id: 1, status: "retired" }) });
    await retirePrompt(raw, 1, fetchFn as any);
    const row = await prep(raw, "SELECT status, closed_at FROM prompts WHERE prompt_id = 1").get() as any;
    expect(row.status).toBe("retired");
    expect(row.closed_at).not.toBeNull();
    expect(fetchFn).toHaveBeenCalledWith("http://127.0.0.1:8001/arms/1/retire", expect.anything());
  });

  it("refuses to retire a superseded prompt, leaving its status and closed_at untouched", async () => {
    const raw = await createTestDb();
    await seedConfirmedPrompt(raw, "superseded");
    await prep(raw, "UPDATE prompts SET closed_at = '2026-10-01T00:00:00.000Z' WHERE prompt_id = 1").run();
    const fetchFn = vi.fn();
    await expect(retirePrompt(raw, 1, fetchFn as any)).rejects.toThrow(/already superseded/);
    expect(await prep(raw, "SELECT status, closed_at FROM prompts WHERE prompt_id = 1").get()).toEqual({ status: "superseded", closed_at: "2026-10-01T00:00:00.000Z" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("still retires locally and returns a warning (not a throw) when the engine's retire call fails", async () => {
    const raw = await createTestDb();
    await seedConfirmedPrompt(raw);
    const fetchFn = vi.fn().mockRejectedValue(new Error("engine down"));
    const { warning } = await retirePrompt(raw, 1, fetchFn as any);
    expect(warning).toMatch(/retired, but notifying the engine failed: engine down/);
    expect((await prep(raw, "SELECT status FROM prompts WHERE prompt_id = 1").get() as any).status).toBe("retired");
  });

  it("returns warning null when the engine's retire call succeeds", async () => {
    const raw = await createTestDb();
    await seedConfirmedPrompt(raw);
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ prompt_id: 1, status: "retired" }) });
    expect(await retirePrompt(raw, 1, fetchFn as any)).toEqual({ warning: null });
  });

  it("refuses to retire a prompt that is already retired", async () => {
    const raw = await createTestDb();
    await seedConfirmedPrompt(raw, "retired");
    await expect(retirePrompt(raw, 1, vi.fn() as any)).rejects.toThrow(/already retired/);
  });
});
