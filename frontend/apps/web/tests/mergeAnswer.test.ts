import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { createDraft, updateDraft, getDraft } from "@/server/drafts";
import { applyAnswer, setAtPath } from "@/server/mergeAnswer";
import { compileDraft } from "@/server/compileDraft";

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

  it("answering the structure question of a null-structure compile sets BOTH the structure column and spec.structure, keeping the conditions the model found (I2)", async () => {
    const raw = createTestDb();
    const userId = ensureOwnerUser(raw);
    const { draftId } = createDraft(raw, { userId });
    updateDraft(raw, draftId, { promptText: "VStop(10,2,close) flips up" });
    const fetchFn = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/conditions")) return { ok: true, text: async () => JSON.stringify([{ kind: "indicator", name: "vstop", required_params: [{ name: "length" }, { name: "mult" }, { name: "source" }] }]) };
      return { ok: true, text: async () => JSON.stringify([{ structure: "literal" }, { structure: "t1_literal" }]) };
    });
    const callModel = vi.fn().mockResolvedValue(JSON.stringify({
      structure: null,
      conditions: [{ id: "C1", role: "event", kind: "indicator", name: "vstop", params: { length: 10, mult: 2, source: "close" }, op: "flip", dir: "long" }],
      selection_point: null, stop: { from: "C1" }, risk_cap_pct: null, near_miss: null, t1_window: null,
      source_phrases: [{ path: "conditions.0.params.length", phrase: "10" }, { path: "conditions.0.params.mult", phrase: "2" }, { path: "conditions.0.params.source", phrase: "close" }],
      needs_input: [], unsupported: [],
    }));
    await compileDraft(raw, draftId, { fetchFn: fetchFn as any, callModel });

    const draft = applyAnswer(raw, draftId, { path: "structure", value: "literal" });
    expect(draft.structure).toBe("literal");
    expect(draft.spec!.structure).toBe("literal");
    expect(draft.spec!.conditions).toEqual([
      { id: "C1", role: "event", kind: "indicator", name: "vstop", params: { length: 10, mult: 2, source: "close" }, op: "flip", dir: "long" },
    ]);
    expect(draft.spec!.stop).toEqual({ from: "C1" });
    expect(draft.needsInput).toEqual([]);
  });

  it("rejects a structure answer that isn't literal/t1_literal, writing nothing", () => {
    const raw = createTestDb();
    const userId = ensureOwnerUser(raw);
    const { draftId } = createDraft(raw, { userId });
    const spec = { spec_version: 4, structure: null, timeframe: "1W" as const, selection_point: null, conditions: [], stop: null, risk_cap_pct: null, near_miss: null };
    updateDraft(raw, draftId, { specJson: JSON.stringify(spec), needsInputJson: JSON.stringify([{ path: "structure", question: "Which structure?" }]) });
    expect(() => applyAnswer(raw, draftId, { path: "structure", value: "weekly" })).toThrow(/structure must be one of/);
    const after = getDraft(raw, draftId)!;
    expect(after.structure).toBeNull();
    expect(after.spec!.structure).toBeNull();
    expect(after.needsInput).toHaveLength(1);
  });
});

describe("setAtPath — prototype pollution guard (I4, defense in depth)", () => {
  it.each(["__proto__.polluted", "constructor.prototype.polluted", "conditions.0.__proto__.polluted", "prototype", "a.constructor"])(
    "throws on the unsafe path %s even when called directly",
    (path) => {
      expect(() => setAtPath({ conditions: [{}] }, path, "yes")).toThrow(/unsafe path/);
      expect(({} as any).polluted).toBeUndefined();
    }
  );

  it("refuses a huge array index (would make JSON.stringify emit a giant array)", () => {
    expect(() => setAtPath({ t1_window: { offsets: [] } }, "t1_window.offsets.999999999", 1)).toThrow(/index too large/);
  });

  it("still writes ordinary nested paths", () => {
    const obj: any = { conditions: [{ params: {} }], selection_point: null };
    setAtPath(obj, "conditions.0.params.length", 10);
    setAtPath(obj, "selection_point.at", "open");
    expect(obj).toEqual({ conditions: [{ params: { length: 10 } }], selection_point: { at: "open" } });
  });

  it("the review's exploit — answering a needs_input item whose path is __proto__.polluted — no longer pollutes Object.prototype", () => {
    const raw = createTestDb();
    const userId = ensureOwnerUser(raw);
    const { draftId } = createDraft(raw, { userId });
    const spec = { spec_version: 4, structure: "literal" as const, timeframe: "1W" as const, selection_point: null, conditions: [], stop: null, risk_cap_pct: null, near_miss: null };
    // Planted directly (bypassing compile.ts's path grammar, layer 1) to prove layer 2 holds alone.
    updateDraft(raw, draftId, { structure: "literal", specJson: JSON.stringify(spec), needsInputJson: JSON.stringify([{ path: "__proto__.polluted", question: "?" }]) });
    try {
      expect(() => applyAnswer(raw, draftId, { path: "__proto__.polluted", value: "yes" })).toThrow(/unsafe path/);
      expect(({} as any).polluted).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
    } finally {
      delete (Object.prototype as any).polluted;
    }
  });
});
