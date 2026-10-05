import { describe, expect, it } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { createDraft, getDraft, updateDraft } from "@/server/drafts";

function setup() {
  const raw = createTestDb();
  const userId = ensureOwnerUser(raw);
  return { raw, userId };
}

describe("createDraft", () => {
  it("creates an open draft with an empty prompt_text and no spec", () => {
    const { raw, userId } = setup();
    const { draftId } = createDraft(raw, { userId });
    const row = getDraft(raw, draftId)!;
    expect(row.status).toBe("open");
    expect(row.promptText).toBe("");
    expect(row.spec).toBeNull();
  });
});

describe("updateDraft", () => {
  it("stores structure and a spec built from manual condition rows", () => {
    const { raw, userId } = setup();
    const { draftId } = createDraft(raw, { userId });
    const spec = {
      spec_version: 4, structure: "literal" as const, timeframe: "1W" as const,
      selection_point: { session_of_week: 1, at: "open" as const },
      conditions: [
        { id: "C1", role: "filter" as const, kind: "field" as const, name: "mcap_cr", params: {}, op: "between", value: [10000, 50000] },
      ],
      stop: null, risk_cap_pct: null, near_miss: null,
    };
    const updated = updateDraft(raw, draftId, {
      structure: "literal",
      specJson: JSON.stringify(spec),
      hypothesis: "mid-caps in an uptrend outperform",
      killCriterion: "negative expectancy after 13 weeks",
    });
    expect(updated.structure).toBe("literal");
    expect(updated.spec?.conditions).toHaveLength(1);
    expect(updated.hypothesis).toBe("mid-caps in an uptrend outperform");
  });

  it("bumps updated_at and throws on an unknown draft id", () => {
    const { raw } = setup();
    expect(() => updateDraft(raw, 999, { title: "x" })).toThrow(/draft 999 not found/);
  });

  it("rejects a prompt_text over 2000 chars (DB CHECK) with a clear error, not a raw SQLite exception", () => {
    const { raw, userId } = setup();
    const { draftId } = createDraft(raw, { userId });
    expect(() => updateDraft(raw, draftId, { promptText: "x".repeat(2001) })).toThrow(/2000/);
  });

  it("rejects a specJson that isn't a valid ScreenSpec (e.g. a structure the schema doesn't allow)", () => {
    const { raw, userId } = setup();
    const { draftId } = createDraft(raw, { userId });
    const badSpec = {
      spec_version: 4, structure: "control", timeframe: "1W", selection_point: null,
      conditions: [], stop: null, risk_cap_pct: null, near_miss: null,
    };
    expect(() => updateDraft(raw, draftId, { specJson: JSON.stringify(badSpec) })).toThrow(/invalid spec/i);
  });

  it("rejects a specJson with duplicate condition ids", () => {
    const { raw, userId } = setup();
    const { draftId } = createDraft(raw, { userId });
    const badSpec = {
      spec_version: 4, structure: "literal", timeframe: "1W", selection_point: null,
      conditions: [
        { id: "C1", role: "filter", kind: "field", name: "mcap_cr", params: {}, op: "between", value: [1, 2] },
        { id: "C1", role: "filter", kind: "field", name: "mcap_cr", params: {}, op: "between", value: [1, 2] },
      ],
      stop: null, risk_cap_pct: null, near_miss: null,
    };
    expect(() => updateDraft(raw, draftId, { specJson: JSON.stringify(badSpec) })).toThrow(/invalid spec/i);
  });
});
