import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { createDraft, updateDraft, getDraft } from "@/server/drafts";
import { confirmDraft } from "@/server/confirm";
import { EngineError } from "@/server/engine/client";

const SPEC = {
  spec_version: 4, structure: "literal" as const, timeframe: "1W" as const,
  selection_point: { session_of_week: 1, at: "open" as const },
  conditions: [
    { id: "idMcap", role: "filter" as const, kind: "field" as const, name: "mcap_cr", params: {}, op: "between", value: [10000, 50000] },
    { id: "idVstop", role: "event" as const, kind: "indicator" as const, name: "vstop", params: { length: 10, mult: 2, source: "close" }, op: "flip", dir: "long" as const },
  ],
  stop: { from: "idVstop" }, risk_cap_pct: null, near_miss: { max_failed: 1 },
};

function readyDraft(raw: ReturnType<typeof createTestDb>, overrides: Record<string, unknown> = {}) {
  const userId = ensureOwnerUser(raw);
  const { draftId } = createDraft(raw, { userId });
  updateDraft(raw, draftId, {
    title: "Original brief", structure: "literal", specJson: JSON.stringify(SPEC),
    hypothesis: "mid-caps in an uptrend outperform",
    killCriterion: "negative expectancy after 13 weeks",
    ...overrides,
  });
  return draftId;
}

function fakeScreenFetch(candidates: any[]) {
  return vi.fn().mockResolvedValue({
    ok: true,
    text: async () => JSON.stringify({ candidates, applied_steps: [{ step: "x", applied: true, reason: null }], funnel: [], sector_view: [] }),
  });
}

describe("confirmDraft", () => {
  it("mints a prompt_id, a watchlist, and one entry per candidate across all membership types", async () => {
    const raw = createTestDb();
    const draftId = readyDraft(raw);
    const fetchFn = fakeScreenFetch([
      { ticker: "FULL1", membership: "full_match", values: { idMcap: 25000, idVstop: { vstop_line: 90, uptrend: true } }, failed_ids: [], ep: 101.5, sl: 95.0, r: 0.064 },
      { ticker: "NEAR1", membership: "near_miss", values: { idMcap: 9000 }, failed_ids: ["idMcap"], ep: 50.0, sl: null, r: null },
      { ticker: "RISK1", membership: "rejected_risk_cap", values: { idMcap: 20000 }, failed_ids: [], ep: 20.0, sl: 19.0, r: 0.05 },
    ]);

    const { promptId, watchlistId } = await confirmDraft(raw, draftId, "2026-10-02", fetchFn as any);
    expect(promptId).toBeGreaterThan(0);
    expect(watchlistId).toBeGreaterThan(0);

    const prompt = raw.prepare("SELECT * FROM prompts WHERE prompt_id = ?").get(promptId) as any;
    expect(prompt.status).toBe("confirmed");
    expect(prompt.version).toBe(1);

    const conditions = raw.prepare("SELECT value_origin FROM prompt_conditions WHERE prompt_id = ?").all(promptId) as any[];
    expect(conditions).toHaveLength(2);
    expect(conditions.every((c) => c.value_origin === "user_answer")).toBe(true);

    const entries = raw.prepare("SELECT symbol, membership, status, entry_price FROM watchlist_entries WHERE watchlist_id = ? ORDER BY symbol").all(watchlistId) as any[];
    expect(entries).toEqual([
      { symbol: "FULL1", membership: "full_match", status: "pending_selection", entry_price: null },
      { symbol: "NEAR1", membership: "near_miss", status: "watching", entry_price: null },
      { symbol: "RISK1", membership: "rejected_risk_cap", status: "watching", entry_price: null },
    ]);

    const results = raw.prepare("SELECT in_forward_record FROM run_results WHERE run_id = (SELECT MAX(run_id) FROM runs)").all() as any[];
    expect(results.every((r) => r.in_forward_record === 0)).toBe(true);

    const draft = getDraft(raw, draftId)!;
    expect(draft.status).toBe("confirmed");
    expect(draft.confirmedPromptId).toBe(promptId);
  });

  it("remaps the engine's own condition ids (idMcap/idVstop) to the DB's display cond_no (C1/C2) so watchlist reads line up", async () => {
    const raw = createTestDb();
    const draftId = readyDraft(raw);
    const fetchFn = fakeScreenFetch([
      { ticker: "FULL1", membership: "full_match", values: { idMcap: 25000, idVstop: { vstop_line: 90, uptrend: true } }, failed_ids: ["idVstop"], ep: 101.5, sl: 95.0, r: 0.064 },
    ]);
    const { promptId } = await confirmDraft(raw, draftId, "2026-10-02", fetchFn as any);
    const runId = (raw.prepare("SELECT MAX(run_id) AS id FROM runs").get() as any).id;
    const row = raw.prepare("SELECT cond_json, failed_conds_json FROM run_results WHERE run_id = ? AND symbol = 'FULL1'").get(runId) as any;
    expect(JSON.parse(row.cond_json)).toEqual({ C1: 25000, C2: { vstop_line: 90, uptrend: true } });
    expect(JSON.parse(row.failed_conds_json)).toEqual(["C2"]);

    const condNos = raw.prepare("SELECT cond_no, name FROM prompt_conditions WHERE prompt_id = ? ORDER BY cond_no").all(promptId) as any[];
    expect(condNos).toEqual([{ cond_no: 1, name: "mcap_cr" }, { cond_no: 2, name: "vstop" }]);
  });

  it("handles a week with zero candidates without crashing", async () => {
    const raw = createTestDb();
    const draftId = readyDraft(raw);
    const { watchlistId } = await confirmDraft(raw, draftId, "2026-10-02", fakeScreenFetch([]) as any);
    const entries = raw.prepare("SELECT COUNT(*) AS n FROM watchlist_entries WHERE watchlist_id = ?").get(watchlistId) as any;
    expect(entries.n).toBe(0);
  });

  it("blocks when hypothesis is missing", async () => {
    const raw = createTestDb();
    const draftId = readyDraft(raw, { hypothesis: "" });
    await expect(confirmDraft(raw, draftId, "2026-10-02", fakeScreenFetch([]) as any)).rejects.toThrow(/confirm blocked:/);
  });

  it("blocks when the spec is missing", async () => {
    const raw = createTestDb();
    const userId = ensureOwnerUser(raw);
    const { draftId } = createDraft(raw, { userId });
    await expect(confirmDraft(raw, draftId, "2026-10-02", fakeScreenFetch([]) as any)).rejects.toThrow(/confirm blocked:/);
  });

  it("propagates a 422 from the engine without writing anything", async () => {
    const raw = createTestDb();
    const draftId = readyDraft(raw);
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 422, text: async () => JSON.stringify({ errors: [{ condition_id: "C2", message: "unsupported" }] }) });
    await expect(confirmDraft(raw, draftId, "2026-10-02", fetchFn as any)).rejects.toBeInstanceOf(EngineError);
    const count = raw.prepare("SELECT COUNT(*) AS n FROM prompts").get() as any;
    expect(count.n).toBe(0);
  });

  it("rejects confirming an already-confirmed draft", async () => {
    const raw = createTestDb();
    const draftId = readyDraft(raw);
    await confirmDraft(raw, draftId, "2026-10-02", fakeScreenFetch([]) as any);
    await expect(confirmDraft(raw, draftId, "2026-10-09", fakeScreenFetch([]) as any)).rejects.toThrow(/already confirmed/);
  });
});
