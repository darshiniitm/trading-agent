import { describe, expect, it } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { createDraft, updateDraft, getDraft } from "@/server/drafts";
import { applyAnswer } from "@/server/mergeAnswer";

function compiledDraftMissingLength(raw: ReturnType<typeof createTestDb>) {
  const userId = ensureOwnerUser(raw);
  const { draftId } = createDraft(raw, { userId });
  const spec = {
    spec_version: 4, structure: "literal" as const, timeframe: "1W" as const, selection_point: null,
    conditions: [{ id: "C1", role: "event" as const, kind: "indicator" as const, name: "vstop", params: { mult: 2, source: "close" }, op: "flip", dir: "long" as const }],
    stop: { from: "C1" }, risk_cap_pct: null, near_miss: null,
  };
  updateDraft(raw, draftId, {
    structure: "literal", specJson: JSON.stringify(spec),
    needsInputJson: JSON.stringify([{ path: "conditions.0.params.length", question: "What VStop length?" }]),
  });
  return draftId;
}

describe("applyAnswer", () => {
  it("writes the answered value into spec_json at the given path and removes the needs_input item", () => {
    const raw = createTestDb();
    const draftId = compiledDraftMissingLength(raw);
    const draft = applyAnswer(raw, draftId, { path: "conditions.0.params.length", value: 10 });
    expect(draft.spec!.conditions[0].params.length).toBe(10);
    expect(draft.needsInput).toEqual([]);
  });

  it("records the answer so it can be told apart from a model-sourced value later", () => {
    const raw = createTestDb();
    const draftId = compiledDraftMissingLength(raw);
    applyAnswer(raw, draftId, { path: "conditions.0.params.length", value: 10 });
    const row = raw.prepare("SELECT answers_json FROM prompt_drafts WHERE draft_id = ?").get(draftId) as any;
    expect(JSON.parse(row.answers_json)).toEqual([{ path: "conditions.0.params.length", value: 10 }]);
  });

  it("rejects a path nobody asked about", () => {
    const raw = createTestDb();
    const draftId = compiledDraftMissingLength(raw);
    expect(() => applyAnswer(raw, draftId, { path: "risk_cap_pct", value: 15 })).toThrow(/not a current needs_input item/);
  });

  it("can fill a top-level path like selection_point.session_of_week by creating the object", () => {
    const raw = createTestDb();
    const userId = ensureOwnerUser(raw);
    const { draftId } = createDraft(raw, { userId });
    const spec = {
      spec_version: 4, structure: "literal" as const, timeframe: "1W" as const, selection_point: null,
      conditions: [], stop: null, risk_cap_pct: null, near_miss: null,
    };
    updateDraft(raw, draftId, { structure: "literal", specJson: JSON.stringify(spec), needsInputJson: JSON.stringify([{ path: "selection_point.session_of_week", question: "Which session of the week?" }]) });
    const draft = applyAnswer(raw, draftId, { path: "selection_point.session_of_week", value: 1 });
    expect(draft.spec!.selection_point).toEqual({ session_of_week: 1 });
  });
});
