import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { createDraft, updateDraft } from "@/server/drafts";
import { dryRunDraft } from "@/server/dryrun";
import { EngineError } from "@/server/engine/client";

const SPEC = {
  spec_version: 4, structure: "literal" as const, timeframe: "1W" as const,
  selection_point: null,
  conditions: [{ id: "C1", role: "filter" as const, kind: "field" as const, name: "mcap_cr", params: {}, op: "between", value: [10000, 50000] }],
  stop: null, risk_cap_pct: null, near_miss: null,
};

function draftWithSpec(spec: unknown) {
  const raw = createTestDb();
  const userId = ensureOwnerUser(raw);
  const { draftId } = createDraft(raw, { userId });
  if (spec) updateDraft(raw, draftId, { structure: "literal", specJson: JSON.stringify(spec) });
  return { raw, draftId };
}

describe("dryRunDraft", () => {
  it("calls the engine with the draft's current spec and returns the result unchanged", async () => {
    const { raw, draftId } = draftWithSpec(SPEC);
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ candidates: [{ ticker: "ABC" }], applied_steps: [], funnel: [], sector_view: [] }),
    });
    const result = await dryRunDraft(raw, draftId, "2026-10-02", fetchFn as any);
    expect(result.candidates).toEqual([{ ticker: "ABC" }]);
    const [, init] = fetchFn.mock.calls[0];
    expect(JSON.parse(init.body).spec).toEqual(SPEC);
  });

  it("writes nothing to runs/run_results/prompts/watchlists", async () => {
    const { raw, draftId } = draftWithSpec(SPEC);
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ candidates: [], applied_steps: [], funnel: [], sector_view: [] }) });
    await dryRunDraft(raw, draftId, "2026-10-02", fetchFn as any);
    await dryRunDraft(raw, draftId, "2026-10-02", fetchFn as any);
    for (const table of ["runs", "run_results", "prompts", "watchlists"]) {
      const count = raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any;
      expect(count.n).toBe(0);
    }
  });

  it("throws if the draft has no spec yet", async () => {
    const { raw, draftId } = draftWithSpec(null);
    await expect(dryRunDraft(raw, draftId, "2026-10-02", vi.fn() as any)).rejects.toThrow(/no spec yet/);
  });

  it("propagates an EngineError from a 422 unchanged", async () => {
    const { raw, draftId } = draftWithSpec(SPEC);
    const fetchFn = vi.fn().mockResolvedValue({
      // engine/app.py's HTTPException(422, detail=[...]) serializes to {"detail": [...]}, not {"errors": [...]}.
      ok: false, status: 422, text: async () => JSON.stringify({ detail: [{ condition_id: "C1", message: "bad" }] }),
    });
    await expect(dryRunDraft(raw, draftId, "2026-10-02", fetchFn as any)).rejects.toBeInstanceOf(EngineError);
  });
});
