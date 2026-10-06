import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { createDraft, updateDraft } from "@/server/drafts";
import { confirmDraft } from "@/server/confirm";

describe("confirmDraft — value_origin from the compiler path", () => {
  it("marks a condition 'prompt' origin when every one of its numeric leaves has a source phrase", async () => {
    const raw = createTestDb();
    const userId = ensureOwnerUser(raw);
    const { draftId } = createDraft(raw, { userId });
    const spec = {
      spec_version: 4, structure: "literal" as const, timeframe: "1W" as const, selection_point: null,
      conditions: [{ id: "C1", role: "event" as const, kind: "indicator" as const, name: "vstop", params: { length: 10, mult: 2, source: "close" }, op: "flip", dir: "long" as const }],
      stop: { from: "C1" }, risk_cap_pct: null, near_miss: null,
    };
    updateDraft(raw, draftId, {
      structure: "literal", specJson: JSON.stringify(spec), hypothesis: "h", killCriterion: "k",
      needsInputJson: "[]", unsupportedJson: "[]",
      sourcePhrasesJson: JSON.stringify([{ path: "conditions.0.params.length", phrase: "VStop 10" }, { path: "conditions.0.params.mult", phrase: "mult 2" }]),
    });
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ candidates: [], applied_steps: [], funnel: [], sector_view: [] }) });
    const { promptId } = await confirmDraft(raw, draftId, "2026-10-02", fetchFn as any);

    const row = raw.prepare("SELECT value_origin, source_phrase FROM prompt_conditions WHERE prompt_id = ? AND cond_no = 1").get(promptId) as any;
    expect(row.value_origin).toBe("prompt");
    expect(row.source_phrase).toContain("VStop 10");
  });

  it("marks a condition 'user_answer' origin when any one of its numeric leaves came from an answer, not a source phrase", async () => {
    const raw = createTestDb();
    const userId = ensureOwnerUser(raw);
    const { draftId } = createDraft(raw, { userId });
    const spec = {
      spec_version: 4, structure: "literal" as const, timeframe: "1W" as const, selection_point: null,
      conditions: [{ id: "C1", role: "event" as const, kind: "indicator" as const, name: "vstop", params: { length: 10, mult: 2, source: "close" }, op: "flip", dir: "long" as const }],
      stop: { from: "C1" }, risk_cap_pct: null, near_miss: null,
    };
    updateDraft(raw, draftId, {
      structure: "literal", specJson: JSON.stringify(spec), hypothesis: "h", killCriterion: "k",
      needsInputJson: "[]", unsupportedJson: "[]",
      sourcePhrasesJson: JSON.stringify([{ path: "conditions.0.params.mult", phrase: "mult 2" }]),
    });
    raw.prepare("UPDATE prompt_drafts SET answers_json = ? WHERE draft_id = ?").run(JSON.stringify([{ path: "conditions.0.params.length", value: 10 }]), draftId);
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ candidates: [], applied_steps: [], funnel: [], sector_view: [] }) });
    const { promptId } = await confirmDraft(raw, draftId, "2026-10-02", fetchFn as any);

    const row = raw.prepare("SELECT value_origin FROM prompt_conditions WHERE prompt_id = ? AND cond_no = 1").get(promptId) as any;
    expect(row.value_origin).toBe("user_answer");
  });

  it("manual-form drafts (no sourcePhrases/needsInput ever set) are unaffected — still always user_answer, source_phrase NULL", async () => {
    const raw = createTestDb();
    const userId = ensureOwnerUser(raw);
    const { draftId } = createDraft(raw, { userId });
    const spec = {
      spec_version: 4, structure: "literal" as const, timeframe: "1W" as const, selection_point: null,
      conditions: [{ id: "C1", role: "filter" as const, kind: "field" as const, name: "mcap_cr", params: {}, op: "between", value: [10000, 50000] }],
      stop: null, risk_cap_pct: null, near_miss: null,
    };
    updateDraft(raw, draftId, { structure: "literal", specJson: JSON.stringify(spec), hypothesis: "h", killCriterion: "k" });
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ candidates: [], applied_steps: [], funnel: [], sector_view: [] }) });
    const { promptId } = await confirmDraft(raw, draftId, "2026-10-02", fetchFn as any);

    const row = raw.prepare("SELECT value_origin, source_phrase FROM prompt_conditions WHERE prompt_id = ? AND cond_no = 1").get(promptId) as any;
    expect(row.value_origin).toBe("user_answer");
    expect(row.source_phrase).toBeNull();
  });

  it("a compiler-sourced condition with zero numeric leaves is 'user_answer', not vacuously 'prompt', even with empty sourcePhrases", async () => {
    const raw = createTestDb();
    const userId = ensureOwnerUser(raw);
    const { draftId } = createDraft(raw, { userId });
    const spec = {
      spec_version: 4, structure: "literal" as const, timeframe: "1W" as const, selection_point: null,
      conditions: [{ id: "C1", role: "event" as const, kind: "indicator" as const, name: "vstop", params: {}, op: "flip", dir: "long" as const }],
      stop: { from: "C1" }, risk_cap_pct: null, near_miss: null,
    };
    updateDraft(raw, draftId, {
      structure: "literal", specJson: JSON.stringify(spec), hypothesis: "h", killCriterion: "k",
      needsInputJson: "[]", unsupportedJson: "[]", sourcePhrasesJson: "[]",
    });
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ candidates: [], applied_steps: [], funnel: [], sector_view: [] }) });
    const { promptId } = await confirmDraft(raw, draftId, "2026-10-02", fetchFn as any);

    const row = raw.prepare("SELECT value_origin, source_phrase FROM prompt_conditions WHERE prompt_id = ? AND cond_no = 1").get(promptId) as any;
    expect(row.value_origin).toBe("user_answer");
    expect(row.source_phrase).toBeNull();
  });
});
