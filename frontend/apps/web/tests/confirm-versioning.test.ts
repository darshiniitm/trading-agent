import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { createDraft, updateDraft } from "@/server/drafts";
import { confirmDraft } from "@/server/confirm";
import { createEditDraft } from "@/server/prompts";

import { program, readyDraft as makeReady } from "./helpers/program";

const MCAP_ONLY = program({
  sets: [{ id: "S1", from: "universe", where: { all: ["C1"] } }],
  conditions: [{ id: "C1", lhs: { field: "mcap_cr" }, op: "between", value: [10000, 50000] }],
  actions: [],
});

function readyDraft(raw: ReturnType<typeof createTestDb>) {
  return makeReady(raw, { prog: MCAP_ONLY, hypothesis: "h", killCriterion: "k" });
}

describe("confirmDraft — selection failure tolerance", () => {
  it("still returns promptId/watchlistId with a selectionWarning when /select (or /arms/register) is unreachable after the screen succeeds", async () => {
    const raw = createTestDb();
    const draftId = readyDraft(raw);
    let call = 0;
    const fetchFn = vi.fn().mockImplementation(async (url: string) => {
      call += 1;
      if (url.endsWith("/screen")) {
        return { ok: true, text: async () => JSON.stringify({ candidates: [], applied_steps: [], funnel: [], sector_view: [] }) };
      }
      return { ok: false, status: 503, text: async () => JSON.stringify({ error: "engine unreachable" }) };
    });

    const { promptId, watchlistId, selectionWarning } = await confirmDraft(raw, draftId, "2026-10-02", fetchFn as any);
    expect(promptId).toBeGreaterThan(0);
    expect(watchlistId).toBeGreaterThan(0);
    expect(selectionWarning).toMatch(/selection could not run yet/);

    const prompt = raw.prepare("SELECT status FROM prompts WHERE prompt_id = ?").get(promptId) as any;
    expect(prompt.status).toBe("confirmed");
  });
});

describe("confirmDraft — versioning", () => {
  it("confirming an edit draft mints a new prompt_id, parent_prompt_id, version 2, and supersedes the old prompt", async () => {
    const raw = createTestDb();
    const draftId = readyDraft(raw);
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ candidates: [], applied_steps: [], funnel: [], sector_view: [], entered: [], not_confirmed: [], no_point_data: [], watching: [], prompt_id: 1, status: "active" }) });
    const { promptId: v1Id } = await confirmDraft(raw, draftId, "2026-10-02", fetchFn as any);

    const { draftId: editDraftId } = createEditDraft(raw, { promptId: v1Id, userId: ensureOwnerUser(raw) });
    const { promptId: v2Id } = await confirmDraft(raw, editDraftId, "2026-10-09", fetchFn as any);

    expect(v2Id).not.toBe(v1Id);
    const v2 = raw.prepare("SELECT parent_prompt_id, version, status FROM prompts WHERE prompt_id = ?").get(v2Id) as any;
    expect(v2).toEqual({ parent_prompt_id: v1Id, version: 2, status: "confirmed" });
    const v1 = raw.prepare("SELECT status FROM prompts WHERE prompt_id = ?").get(v1Id) as any;
    expect(v1.status).toBe("superseded");

    expect(fetchFn).toHaveBeenCalledWith(`http://127.0.0.1:8001/arms/${v1Id}/retire`, expect.anything());
  });

  it("reverts the parent back to confirmed (not stuck superseded) if the version-mint's weekly screen fails", async () => {
    const raw = createTestDb();
    const draftId = readyDraft(raw);
    const okFetch = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ candidates: [], applied_steps: [], funnel: [], sector_view: [], entered: [], not_confirmed: [], no_point_data: [], watching: [], prompt_id: 1, status: "active" }) });
    const { promptId: v1Id } = await confirmDraft(raw, draftId, "2026-10-02", okFetch as any);

    const { draftId: editDraftId } = createEditDraft(raw, { promptId: v1Id, userId: ensureOwnerUser(raw) });
    const failingFetch = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => JSON.stringify({ error: "engine down" }) });
    await expect(confirmDraft(raw, editDraftId, "2026-10-09", failingFetch as any)).rejects.toThrow();

    const v1 = raw.prepare("SELECT status, closed_at FROM prompts WHERE prompt_id = ?").get(v1Id) as any;
    expect(v1.status).toBe("confirmed");
    expect(v1.closed_at).toBeNull();

    const v2Count = (raw.prepare("SELECT COUNT(*) as c FROM prompts WHERE parent_prompt_id = ?").get(v1Id) as any).c;
    expect(v2Count).toBe(0);
  });

  it("still returns the new version normally, with a selectionWarning, if notifying the engine to retire the parent fails", async () => {
    const raw = createTestDb();
    const draftId = readyDraft(raw);
    const okFetch = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ candidates: [], applied_steps: [], funnel: [], sector_view: [], entered: [], not_confirmed: [], no_point_data: [], watching: [], prompt_id: 1, status: "active" }) });
    const { promptId: v1Id } = await confirmDraft(raw, draftId, "2026-10-02", okFetch as any);

    const { draftId: editDraftId } = createEditDraft(raw, { promptId: v1Id, userId: ensureOwnerUser(raw) });
    // The new version's own screen/register/select calls all succeed; only the
    // parent's /arms/{id}/retire notification fails (e.g. the engine is briefly
    // unreachable right at that step).
    const fetchFn = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith(`/arms/${v1Id}/retire`)) {
        return { ok: false, status: 503, text: async () => JSON.stringify({ error: "engine unreachable" }) };
      }
      return {
        ok: true,
        text: async () =>
          JSON.stringify({ candidates: [], applied_steps: [], funnel: [], sector_view: [], entered: [], not_confirmed: [], no_point_data: [], watching: [], prompt_id: v1Id, status: "active" }),
      };
    });

    const { promptId: v2Id, watchlistId, selectionWarning } = await confirmDraft(raw, editDraftId, "2026-10-09", fetchFn as any);
    expect(v2Id).not.toBe(v1Id);
    expect(watchlistId).toBeGreaterThan(0);
    expect(selectionWarning).toMatch(/retir/i);

    // The DB-level supersede already happened transactionally with the new
    // version's insert, independent of whether the engine was successfully
    // notified — so the parent is still correctly superseded.
    const v1 = raw.prepare("SELECT status FROM prompts WHERE prompt_id = ?").get(v1Id) as any;
    expect(v1.status).toBe("superseded");
    const v2 = raw.prepare("SELECT status, parent_prompt_id, version FROM prompts WHERE prompt_id = ?").get(v2Id) as any;
    expect(v2).toEqual({ status: "confirmed", parent_prompt_id: v1Id, version: 2 });

    expect(fetchFn).toHaveBeenCalledWith(`http://127.0.0.1:8001/arms/${v1Id}/retire`, expect.anything());
  });
});
