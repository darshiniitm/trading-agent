import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { createDraft, updateDraft } from "@/server/drafts";
import { confirmDraft } from "@/server/confirm";

const SPEC = {
  spec_version: 4, structure: "literal" as const, timeframe: "1W" as const, selection_point: null,
  conditions: [{ id: "C1", role: "filter" as const, kind: "field" as const, name: "mcap_cr", params: {}, op: "between", value: [10000, 50000] }],
  stop: null, risk_cap_pct: null, near_miss: null,
};

function compiledDraft(raw: ReturnType<typeof createTestDb>, overrides: Record<string, unknown>) {
  const userId = ensureOwnerUser(raw);
  const { draftId } = createDraft(raw, { userId });
  updateDraft(raw, draftId, {
    structure: "literal", specJson: JSON.stringify(SPEC), hypothesis: "h", killCriterion: "k",
    needsInputJson: "[]", sourcePhrasesJson: "[]", unsupportedJson: "[]",
    ...overrides,
  });
  return draftId;
}

describe("confirmDraft — compiler confirm gate", () => {
  it("blocks confirm while needs_input is non-empty", async () => {
    const raw = createTestDb();
    const draftId = compiledDraft(raw, { needsInputJson: JSON.stringify([{ path: "conditions.0.params.length", question: "What length?" }]) });
    await expect(confirmDraft(raw, draftId, "2026-10-02", vi.fn() as any)).rejects.toThrow(/needs_input/);
  });

  it("blocks confirm while an unsupported condition is still present", async () => {
    const raw = createTestDb();
    const draftId = compiledDraft(raw, { unsupportedJson: JSON.stringify([{ text: "MACD crossover", reason: "not in catalog" }]) });
    await expect(confirmDraft(raw, draftId, "2026-10-02", vi.fn() as any)).rejects.toThrow(/unsupported/);
  });

  it("confirms normally once needs_input and unsupported are both empty", async () => {
    const raw = createTestDb();
    const draftId = compiledDraft(raw, {});
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ candidates: [], applied_steps: [], funnel: [], sector_view: [] }) });
    const { promptId } = await confirmDraft(raw, draftId, "2026-10-02", fetchFn as any);
    expect(promptId).toBeGreaterThan(0);
  });
});
