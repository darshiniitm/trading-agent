import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { createDraft, updateDraft, getDraft } from "@/server/drafts";
import { compileDraft } from "@/server/compileDraft";
import { CompileError } from "@/server/compiler/compile";

function draftWithText(raw: ReturnType<typeof createTestDb>, text: string) {
  const userId = ensureOwnerUser(raw);
  const { draftId } = createDraft(raw, { userId });
  updateDraft(raw, draftId, { promptText: text });
  return draftId;
}

function fakeEngineFetch() {
  return vi.fn().mockImplementation(async (url: string) => {
    if (url.endsWith("/conditions")) return { ok: true, text: async () => JSON.stringify([{ kind: "indicator", name: "vstop", required_params: [{ name: "length" }, { name: "mult" }, { name: "source" }] }]) };
    if (url.endsWith("/structures")) return { ok: true, text: async () => JSON.stringify([{ structure: "literal" }, { structure: "t1_literal" }]) };
    throw new Error(`unexpected url ${url}`);
  });
}

describe("compileDraft", () => {
  it("on success, writes structure/specJson/sourcePhrases onto the draft and logs a compilations row", async () => {
    const raw = createTestDb();
    const draftId = draftWithText(raw, "VStop(10,2,close) flip up");
    const callModel = vi.fn().mockResolvedValue(JSON.stringify({
      structure: "literal",
      conditions: [{ id: "C1", role: "event", kind: "indicator", name: "vstop", params: { length: 10, mult: 2, source: "close" }, op: "flip", dir: "long" }],
      selection_point: null, stop: { from: "C1" }, risk_cap_pct: null, near_miss: null, t1_window: null,
      source_phrases: [{ path: "conditions.0.params.length", phrase: "10" }, { path: "conditions.0.params.mult", phrase: "2" }, { path: "conditions.0.params.source", phrase: "close" }],
      needs_input: [], unsupported: [],
    }));

    const draft = await compileDraft(raw, draftId, { fetchFn: fakeEngineFetch() as any, callModel });
    expect(draft.structure).toBe("literal");
    expect(draft.spec?.conditions).toHaveLength(1);
    expect(draft.sourcePhrases).toHaveLength(3);

    const compilation = raw.prepare("SELECT model, errors_json FROM compilations WHERE draft_id = ?").get(draftId) as any;
    expect(compilation.model).toBeTruthy();
    expect(compilation.errors_json).toBeNull();
  });

  it("when structure is null, writes needs_input (plus a structure question) and a structure-null spec", async () => {
    const raw = createTestDb();
    const draftId = draftWithText(raw, "something vague");
    const callModel = vi.fn().mockResolvedValue(JSON.stringify({
      structure: null, conditions: [], selection_point: null, stop: null, risk_cap_pct: null, near_miss: null, t1_window: null,
      source_phrases: [], needs_input: [], unsupported: [{ text: "MACD crossover", reason: "MACD is not in the catalog" }],
    }));

    const draft = await compileDraft(raw, draftId, { fetchFn: fakeEngineFetch() as any, callModel });
    expect(draft.spec).toMatchObject({ structure: null, conditions: [] });
    expect(draft.structure).toBeNull();
    expect(draft.needsInput!.some((n) => n.path === "structure")).toBe(true);
    // Structure being unresolved doesn't stop the model from flagging an
    // independently-unsupported condition in the same prompt — both facts
    // should reach the draft.
    expect(draft.unsupported).toEqual([{ text: "MACD crossover", reason: "MACD is not in the catalog" }]);
  });

  it("when structure is null, keeps every condition/selection point/stop the model DID find in a structure-null spec (I2)", async () => {
    const raw = createTestDb();
    const draftId = draftWithText(raw, "VStop(10,2,close) flips up, Monday open");
    const callModel = vi.fn().mockResolvedValue(JSON.stringify({
      structure: null,
      conditions: [{ id: "C1", role: "event", kind: "indicator", name: "vstop", params: { length: 10, mult: 2, source: "close" }, op: "flip", dir: "long" }],
      selection_point: { session_of_week: 1, at: "open" }, stop: { from: "C1" }, risk_cap_pct: null, near_miss: null, t1_window: null,
      source_phrases: [
        { path: "conditions.0.params.length", phrase: "10" }, { path: "conditions.0.params.mult", phrase: "2" }, { path: "conditions.0.params.source", phrase: "close" },
        { path: "selection_point.session_of_week", phrase: "Monday" }, { path: "selection_point.at", phrase: "open" },
      ],
      needs_input: [], unsupported: [],
    }));
    const draft = await compileDraft(raw, draftId, { fetchFn: fakeEngineFetch() as any, callModel });
    expect(draft.structure).toBeNull();
    expect(draft.spec).toEqual({
      spec_version: 4, structure: null, timeframe: "1W",
      selection_point: { session_of_week: 1, at: "open" },
      conditions: [{ id: "C1", role: "event", kind: "indicator", name: "vstop", params: { length: 10, mult: 2, source: "close" }, op: "flip", dir: "long" }],
      stop: { from: "C1" }, risk_cap_pct: null, near_miss: null, t1_window: null,
    });
    expect(draft.needsInput).toEqual([expect.objectContaining({ path: "structure" })]);
  });

  it("on CompileError, writes nothing to the draft's structure/specJson and logs errors_json", async () => {
    const raw = createTestDb();
    const draftId = draftWithText(raw, "x");
    const callModel = vi.fn().mockResolvedValue("not json");

    await expect(compileDraft(raw, draftId, { fetchFn: fakeEngineFetch() as any, callModel })).rejects.toBeInstanceOf(CompileError);
    const draft = getDraft(raw, draftId)!;
    expect(draft.structure).toBeNull();
    expect(draft.spec).toBeNull();
    const compilation = raw.prepare("SELECT errors_json FROM compilations WHERE draft_id = ?").get(draftId) as any;
    expect(JSON.parse(compilation.errors_json)).toEqual(expect.arrayContaining(["response was not valid JSON"]));
  });

  it("throws when the draft has no prompt text yet", async () => {
    const raw = createTestDb();
    const userId = ensureOwnerUser(raw);
    const { draftId } = createDraft(raw, { userId });
    await expect(compileDraft(raw, draftId, { fetchFn: fakeEngineFetch() as any, callModel: vi.fn() })).rejects.toThrow(/no prompt text/);
  });
});
