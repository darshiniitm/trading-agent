import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { createDraft, updateDraft } from "@/server/drafts";
import { confirmDraft } from "@/server/confirm";

const SPEC = {
  spec_version: 4, structure: "literal" as const, timeframe: "1W" as const,
  selection_point: { session_of_week: 1, at: "open" as const },
  conditions: [{ id: "idMcap", role: "filter" as const, kind: "field" as const, name: "mcap_cr", params: {}, op: "between", value: [10000, 50000] }],
  stop: null, risk_cap_pct: null, near_miss: null,
};

function readyDraft(raw: ReturnType<typeof createTestDb>) {
  const userId = ensureOwnerUser(raw);
  const { draftId } = createDraft(raw, { userId });
  updateDraft(raw, draftId, { title: "Original brief", structure: "literal", specJson: JSON.stringify(SPEC), hypothesis: "h", killCriterion: "k" });
  return draftId;
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
