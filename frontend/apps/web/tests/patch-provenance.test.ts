// I1: a manual edit through the generic PATCH /api/drafts/:draftId route must
// never be confirmed as 'prompt'-origin with the ORIGINAL source phrase.
import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { createDraft, getDraft, updateDraft } from "@/server/drafts";
import { compileDraft } from "@/server/compileDraft";
import { applyAnswer } from "@/server/mergeAnswer";
import { confirmDraft } from "@/server/confirm";

let raw = createTestDb();
vi.mock("@/server/db/client", () => ({ db: () => raw }));

import { PATCH as patchDraftRoute } from "@/../app/api/drafts/[draftId]/route";

const COMPILED = {
  structure: "literal",
  conditions: [
    { id: "C1", role: "event", kind: "indicator", name: "vstop", params: { length: 10, mult: 2, source: "close" }, op: "flip", dir: "long" },
    { id: "C2", role: "filter", kind: "indicator", name: "rsi", params: { length: 14 }, op: "between", value: [50, 65] },
  ],
  selection_point: null, stop: { from: "C1" }, risk_cap_pct: null, near_miss: null, t1_window: null,
  source_phrases: [
    { path: "conditions.0.params.length", phrase: "VStop 10" }, { path: "conditions.0.params.mult", phrase: "multiplier 2" },
    { path: "conditions.0.params.source", phrase: "on the close" },
    { path: "conditions.1.params.length", phrase: "RSI 14" }, { path: "conditions.1.value.0", phrase: "between 50" }, { path: "conditions.1.value.1", phrase: "and 65" },
  ],
  needs_input: [], unsupported: [],
};

const engineFetch = vi.fn().mockImplementation(async (url: string) => {
  if (url.endsWith("/conditions")) {
    return { ok: true, text: async () => JSON.stringify([
      { kind: "indicator", name: "vstop", required_params: [{ name: "length" }, { name: "mult" }, { name: "source" }] },
      { kind: "indicator", name: "rsi", required_params: [{ name: "length" }] },
    ]) };
  }
  if (url.endsWith("/structures")) return { ok: true, text: async () => JSON.stringify([{ structure: "literal" }, { structure: "t1_literal" }]) };
  return { ok: true, text: async () => JSON.stringify({ candidates: [], applied_steps: [], funnel: [], sector_view: [] }) };
});

async function compiledDraft(output: unknown = COMPILED) {
  raw = createTestDb();
  const userId = ensureOwnerUser(raw);
  const { draftId } = createDraft(raw, { userId });
  updateDraft(raw, draftId, { promptText: "VStop(10,2) on the close flips up, RSI 14 between 50 and 65" });
  await compileDraft(raw, draftId, { fetchFn: engineFetch as any, callModel: vi.fn().mockResolvedValue(JSON.stringify(output)) });
  return draftId;
}

// What DraftEditor.saveSpec() sends: the whole spec, built from the form.
function patch(draftId: number, body: Record<string, unknown>) {
  return patchDraftRoute(
    new Request(`http://localhost/api/drafts/${draftId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    { params: { draftId: String(draftId) } }
  );
}

function specWith(draftId: number, mutate: (spec: any) => void) {
  const spec = JSON.parse(JSON.stringify(getDraft(raw, draftId)!.spec));
  mutate(spec);
  return { structure: "literal", specJson: JSON.stringify(spec), hypothesis: "h", killCriterion: "k" };
}

async function confirmedOrigins(draftId: number) {
  const { promptId } = await confirmDraft(raw, draftId, "2026-10-02", engineFetch as any);
  return raw.prepare("SELECT value_origin, source_phrase FROM prompt_conditions WHERE prompt_id = ? ORDER BY cond_no").all(promptId) as {
    value_origin: string; source_phrase: string | null;
  }[];
}

describe("PATCH /api/drafts/:draftId — manual edits invalidate compiler provenance (I1)", () => {
  it("editing ONE compiled condition's value clears all source phrases: EVERY condition confirms as user_answer, not just the edited one", async () => {
    const draftId = await compiledDraft();
    const res = await patch(draftId, specWith(draftId, (s) => { s.conditions[0].params.length = 12; }));
    expect(res.status).toBe(200);
    expect(getDraft(raw, draftId)!.sourcePhrases).toBeNull();

    const rows = await confirmedOrigins(draftId);
    expect(rows).toEqual([
      { value_origin: "user_answer", source_phrase: null },
      { value_origin: "user_answer", source_phrase: null },
    ]);
  });

  it("a save that leaves every traced value as compiled (e.g. only appends the liquidity filter + hypothesis) keeps provenance", async () => {
    const draftId = await compiledDraft();
    await patch(draftId, specWith(draftId, (s) => {
      s.conditions.push({ id: "C3", role: "filter", kind: "field", name: "traded_value_cr", params: { window: "1W" }, op: ">=", value: 10 });
    }));
    expect(getDraft(raw, draftId)!.sourcePhrases).toHaveLength(6);

    const rows = await confirmedOrigins(draftId);
    expect(rows.map((r) => r.value_origin)).toEqual(["prompt", "prompt", "user_answer"]);
    expect(rows[0].source_phrase).toContain("VStop 10");
  });

  it.each([
    ["removing the first condition (traced paths now land on a different one)", (s: any) => { s.conditions.shift(); s.stop = null; }],
    ["renaming a compiled condition while keeping its params", (s: any) => { s.conditions[1].name = "vstop_alt"; }],
    ["changing a compiled condition's operator", (s: any) => { s.conditions[1].op = ">="; }],
    ["changing a traced text value", (s: any) => { s.conditions[0].params.source = "high"; }],
    ["changing one end of a traced band", (s: any) => { s.conditions[1].value = [50, 70]; }],
  ])("%s clears provenance", async (_label, mutate) => {
    const draftId = await compiledDraft();
    await patch(draftId, specWith(draftId, mutate));
    expect(getDraft(raw, draftId)!.sourcePhrases).toBeNull();
  });

  it("a rejected PATCH (invalid spec) clears nothing — the clear is part of the same updateDraft call", async () => {
    const draftId = await compiledDraft();
    const res = await patch(draftId, specWith(draftId, (s) => { s.conditions[1].id = "C1"; s.conditions[0].params.length = 12; }));
    expect(res.status).toBe(400);
    expect(getDraft(raw, draftId)!.sourcePhrases).toHaveLength(6);
  });

  it("a PATCH without specJson (e.g. only the prompt text) leaves provenance alone", async () => {
    const draftId = await compiledDraft();
    await patch(draftId, { promptText: "edited text" });
    expect(getDraft(raw, draftId)!.sourcePhrases).toHaveLength(6);
  });

  it("ignores client-sent sourcePhrasesJson / needsInputJson / unsupportedJson (server-owned; would forge provenance or bypass the confirm gate)", async () => {
    const draftId = await compiledDraft({ ...COMPILED, needs_input: [{ path: "conditions.1.params.length", question: "What RSI length?" }] });
    await patch(draftId, {
      needsInputJson: "[]", unsupportedJson: "[]",
      sourcePhrasesJson: JSON.stringify([{ path: "conditions.0.params.length", phrase: "forged" }]),
    });
    const draft = getDraft(raw, draftId)!;
    expect(draft.needsInput).toHaveLength(1);
    expect(draft.sourcePhrases!.map((p) => p.phrase)).not.toContain("forged");
  });

  it("applyAnswer's path-scoped writes (not this route) never clear the source phrases of paths they didn't touch", async () => {
    const out = {
      ...COMPILED,
      conditions: [COMPILED.conditions[0], { ...COMPILED.conditions[1], params: {} }],
      source_phrases: COMPILED.source_phrases.filter((p) => p.path !== "conditions.1.params.length"),
      needs_input: [{ path: "conditions.1.params.length", question: "What RSI length?" }],
    };
    const draftId = await compiledDraft(out);
    applyAnswer(raw, draftId, { path: "conditions.1.params.length", value: 14 });
    expect(getDraft(raw, draftId)!.sourcePhrases).toHaveLength(5);
    updateDraft(raw, draftId, { hypothesis: "h", killCriterion: "k" });
    const rows = await confirmedOrigins(draftId);
    expect(rows.map((r) => r.value_origin)).toEqual(["prompt", "user_answer"]);
  });
});
