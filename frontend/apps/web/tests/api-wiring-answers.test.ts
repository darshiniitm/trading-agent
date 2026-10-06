import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { createDraft, updateDraft, getDraft } from "@/server/drafts";

const raw = createTestDb();
const ownerId = ensureOwnerUser(raw);

vi.mock("@/server/db/client", () => ({ db: () => raw }));

import { POST as answersRoute } from "@/../app/api/drafts/[draftId]/answers/route";

function draftNeedingLength() {
  const { draftId } = createDraft(raw, { userId: ownerId });
  const spec = {
    spec_version: 4, structure: "literal", timeframe: "1W", selection_point: null,
    conditions: [{ id: "C1", role: "event", kind: "indicator", name: "vstop", params: { mult: 2, source: "close" }, op: "flip", dir: "long" }],
    stop: { from: "C1" }, risk_cap_pct: null, near_miss: null,
  };
  updateDraft(raw, draftId, { structure: "literal", specJson: JSON.stringify(spec), needsInputJson: JSON.stringify([{ path: "conditions.0.params.length", question: "What VStop length?" }]) });
  return draftId;
}

function post(draftId: number, body: string) {
  return answersRoute(
    new Request(`http://localhost/api/drafts/${draftId}/answers`, { method: "POST", headers: { "content-type": "application/json" }, body }),
    { params: { draftId: String(draftId) } }
  );
}

describe("POST /api/drafts/:draftId/answers — request body validation", () => {
  it("accepts {path, value} and returns the updated spec and remaining needs_input", async () => {
    const draftId = draftNeedingLength();
    const res = await post(draftId, JSON.stringify({ path: "conditions.0.params.length", value: 10 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.spec.conditions[0].params.length).toBe(10);
    expect(body.needs_input).toEqual([]);
  });

  it.each([
    ["non-JSON body", "not json"],
    ["missing path", JSON.stringify({ value: 10 })],
    ["non-string path", JSON.stringify({ path: 3, value: 10 })],
    ["missing value", JSON.stringify({ path: "conditions.0.params.length" })],
    ["object value", JSON.stringify({ path: "conditions.0.params.length", value: { __proto__: { polluted: "yes" } } })],
    ["array value", JSON.stringify({ path: "conditions.0.params.length", value: [10] })],
    ["null value", JSON.stringify({ path: "conditions.0.params.length", value: null })],
    ["empty-string value", JSON.stringify({ path: "conditions.0.params.length", value: "" })],
    ["extra keys", JSON.stringify({ path: "conditions.0.params.length", value: 10, structure: "literal" })],
  ])("returns a clean 400 for a %s, writing nothing", async (_label, body) => {
    const draftId = draftNeedingLength();
    const res = await post(draftId, body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/request body must be/);
    expect(getDraft(raw, draftId)!.needsInput).toHaveLength(1);
    expect(({} as any).polluted).toBeUndefined();
  });

  it("a __proto__ path in a well-formed body is refused (it is never a current needs_input item, and setAtPath refuses it anyway)", async () => {
    const draftId = draftNeedingLength();
    const res = await post(draftId, JSON.stringify({ path: "__proto__.polluted", value: "yes" }));
    expect(res.status).toBe(400);
    expect(({} as any).polluted).toBeUndefined();
  });
});
