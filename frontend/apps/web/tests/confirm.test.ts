import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { createDraft, updateDraft, getDraft } from "@/server/drafts";
import { confirmDraft } from "@/server/confirm";
import { EngineError } from "@/server/engine/client";

import { program, readyDraft as makeReady } from "./helpers/program";
import { saveProgramState } from "@/server/drafts";
import { prep } from "./helpers/prep";
import type { Db } from "@/server/db/pg";

function readyDraft(raw: Db, overrides: Record<string, unknown> = {}) {
  return makeReady(raw, overrides);
}

function fakeScreenFetch(candidates: any[]) {
  return vi.fn().mockResolvedValue({
    ok: true,
    text: async () => JSON.stringify({ candidates, applied_steps: [{ step: "x", applied: true, reason: null }], funnel: [], sector_view: [] }),
  });
}

describe("confirmDraft", () => {
  it("mints a prompt_id, a watchlist, and one entry per candidate across all membership types", async () => {
    const raw = await createTestDb();
    const draftId = await readyDraft(raw);
    const fetchFn = fakeScreenFetch([
      { ticker: "FULL1", membership: "full_match", values: { C1: 25000, C2: { vstop_line: 90, uptrend: true } }, failed_ids: [], ep: 101.5, sl: 95.0, r: 0.064 },
      { ticker: "NEAR1", membership: "near_miss", values: { C1: 9000 }, failed_ids: ["C1"], ep: 50.0, sl: null, r: null },
      { ticker: "RISK1", membership: "rejected_risk_cap", values: { C1: 20000 }, failed_ids: [], ep: 20.0, sl: 19.0, r: 0.05 },
    ]);

    const { promptId, watchlistId } = await confirmDraft(raw, draftId, "2026-10-02", fetchFn as any);
    expect(promptId).toBeGreaterThan(0);
    expect(watchlistId).toBeGreaterThan(0);

    const prompt = await prep(raw, "SELECT * FROM prompts WHERE prompt_id = ?").get(promptId) as any;
    expect(prompt.status).toBe("confirmed");
    expect(prompt.version).toBe(1);

    const conditions = await prep(raw, "SELECT value_origin FROM prompt_conditions WHERE prompt_id = ?").all(promptId) as any[];
    expect(conditions).toHaveLength(2);
    expect(conditions.every((c) => c.value_origin === "user_answer")).toBe(true);

    const entries = await prep(raw, "SELECT symbol, membership, status, entry_price FROM watchlist_entries WHERE watchlist_id = ? ORDER BY symbol").all(watchlistId) as any[];
    expect(entries).toEqual([
      { symbol: "FULL1", membership: "full_match", status: "pending_selection", entry_price: null },
      { symbol: "NEAR1", membership: "near_miss", status: "watching", entry_price: null },
      { symbol: "RISK1", membership: "rejected_risk_cap", status: "watching", entry_price: null },
    ]);

    const results = await prep(raw, "SELECT in_forward_record FROM run_results WHERE run_id = (SELECT MAX(run_id) FROM runs)").all() as any[];
    expect(results.every((r) => r.in_forward_record === 0)).toBe(true);

    const draft = (await getDraft(raw, draftId))!;
    expect(draft.status).toBe("confirmed");
    expect(draft.confirmedPromptId).toBe(promptId);
  });

  it("remaps the engine's own condition ids (C1/C2) to the DB's display cond_no (C1/C2) so watchlist reads line up", async () => {
    const raw = await createTestDb();
    const draftId = await readyDraft(raw);
    const fetchFn = fakeScreenFetch([
      { ticker: "FULL1", membership: "full_match", values: { C1: 25000, C2: { vstop_line: 90, uptrend: true } }, failed_ids: ["C2"], ep: 101.5, sl: 95.0, r: 0.064 },
    ]);
    const { promptId } = await confirmDraft(raw, draftId, "2026-10-02", fetchFn as any);
    const runId = (await prep(raw, "SELECT MAX(run_id) AS id FROM runs").get() as any).id;
    const row = await prep(raw, "SELECT cond_json, failed_conds_json FROM run_results WHERE run_id = ? AND symbol = 'FULL1'").get(runId) as any;
    expect(JSON.parse(row.cond_json)).toEqual({ C1: 25000, C2: { vstop_line: 90, uptrend: true } });
    expect(JSON.parse(row.failed_conds_json)).toEqual(["C2"]);

    const condNos = await prep(raw, "SELECT cond_no, name FROM prompt_conditions WHERE prompt_id = ? ORDER BY cond_no").all(promptId) as any[];
    expect(condNos).toEqual([{ cond_no: 1, name: "mcap_cr" }, { cond_no: 2, name: "vstop" }]);
  });

  it("handles a week with zero candidates without crashing", async () => {
    const raw = await createTestDb();
    const draftId = await readyDraft(raw);
    const { watchlistId } = await confirmDraft(raw, draftId, "2026-10-02", fakeScreenFetch([]) as any);
    const entries = await prep(raw, "SELECT COUNT(*) AS n FROM watchlist_entries WHERE watchlist_id = ?").get(watchlistId) as any;
    expect(entries.n).toBe(0);
  });

  it("does not block on a missing hypothesis or kill criterion (optional add-ons)", async () => {
    const raw = await createTestDb();
    const draftId = await readyDraft(raw, { hypothesis: "", killCriterion: "" });
    await expect(await confirmDraft(raw, draftId, "2026-10-02", fakeScreenFetch([]) as any)).resolves.toMatchObject({ promptId: 1 });
  });

  it("blocks when the prompt has not been interpreted", async () => {
    const raw = await createTestDb();
    const userId = await ensureOwnerUser(raw);
    const { draftId } = await createDraft(raw, { userId });
    await expect(await confirmDraft(raw, draftId, "2026-10-02", fakeScreenFetch([]) as any)).rejects.toThrow(/confirm blocked:/);
  });

  it("propagates a 422 from the engine without writing anything", async () => {
    const raw = await createTestDb();
    const draftId = await readyDraft(raw);
    // engine/app.py's HTTPException(422, detail=[...]) serializes to {"detail": [...]}, not {"errors": [...]}.
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 422, text: async () => JSON.stringify({ detail: [{ condition_id: "C2", message: "unsupported" }] }) });
    await expect(await confirmDraft(raw, draftId, "2026-10-02", fetchFn as any)).rejects.toBeInstanceOf(EngineError);
    const count = await prep(raw, "SELECT COUNT(*) AS n FROM prompts").get() as any;
    expect(count.n).toBe(0);
  });

  it("rejects confirming an already-confirmed draft", async () => {
    const raw = await createTestDb();
    const draftId = await readyDraft(raw);
    await confirmDraft(raw, draftId, "2026-10-02", fakeScreenFetch([]) as any);
    await expect(await confirmDraft(raw, draftId, "2026-10-09", fakeScreenFetch([]) as any)).rejects.toThrow(/already confirmed/);
  });

  it("writes every candidate correctly at real-world scale (hundreds of candidates in one screen)", async () => {
    // Regression for a crash found live: preparing a fresh SQL statement
    // inside the per-candidate loop created hundreds of short-lived native
    // better-sqlite3 Statement objects in one synchronous transaction, which
    // crashed the whole process (native assertion in
    // node::RemoveEnvironmentCleanupHook, inside Statement's destructor) the
    // first time a real screen result (93 candidates) went through confirm.
    // This pins the fix (statements prepared once, reused via .run() in the
    // loop) at a candidate count well past what any toy fixture would catch.
    const raw = await createTestDb();
    const draftId = await readyDraft(raw);
    const CANDIDATE_COUNT = 300;
    const candidates = Array.from({ length: CANDIDATE_COUNT }, (_, i) => ({
      ticker: `TICK${i}`, membership: i % 3 === 0 ? "full_match" : i % 3 === 1 ? "near_miss" : "rejected_risk_cap",
      values: { C1: 20000 + i }, failed_ids: i % 3 === 0 ? [] : ["C1"],
      ep: 100 + i, sl: 90 + i, r: 10,
    }));
    const { watchlistId } = await confirmDraft(raw, draftId, "2026-10-02", fakeScreenFetch(candidates) as any);

    const count = await prep(raw, "SELECT COUNT(*) AS n FROM watchlist_entries WHERE watchlist_id = ?").get(watchlistId) as any;
    expect(count.n).toBe(CANDIDATE_COUNT);
    const fullMatchCount = await prep(raw, "SELECT COUNT(*) AS n FROM watchlist_entries WHERE watchlist_id = ? AND membership = 'full_match'").get(watchlistId) as any;
    expect(fullMatchCount.n).toBe(100);
  });

  it("rejects a second draft confirming the exact same spec as an already-confirmed prompt, naming it, instead of a raw SQLite constraint error", async () => {
    const raw = await createTestDb();
    const userId = await ensureOwnerUser(raw);
    const firstDraftId = await readyDraft(raw);
    const { promptId: firstPromptId } = await confirmDraft(raw, firstDraftId, "2026-10-02", fakeScreenFetch([]) as any);

    const { draftId: secondDraftId } = await createDraft(raw, { userId });
    await updateDraft(raw, secondDraftId, { title: "Same brief again", hypothesis: "same hypothesis", killCriterion: "same kill criterion" });
    // the same semantics reached by different wording: the phrase text and answer log must not change identity
    await saveProgramState(raw, secondDraftId, { program: program({ conditions: program().conditions.map((c) => ({ ...c, phrase: "worded differently" })) }), clauses: [], normalised: "" });
    await expect(await confirmDraft(raw, secondDraftId, "2026-10-09", fakeScreenFetch([]) as any)).rejects.toThrow(
      new RegExp(`Prompt ${firstPromptId}`)
    );

    const count = await prep(raw, "SELECT COUNT(*) AS n FROM prompts").get() as any;
    expect(count.n).toBe(1);
  });
});


describe("confirmDraft — v5 gate and provenance", () => {
  const blockedBy = async (raw: Db, draftId: number) =>
    confirmDraft(raw, draftId, "2026-10-02", fakeScreenFetch([]) as any).then(() => null, (e: Error) => e.message);

  it("never blocks on open questions, unsupported or not-understood parts, or liquidity: it resolves them and runs", async () => {
    const raw = await createTestDb();
    const open = await readyDraft(raw, { prog: program({ needs_input: [{ path: "conditions.C2.params.source", reason: "missing" }], answers: [] }) });
    expect(await blockedBy(raw, open)).toBeNull();
    const raw2 = await createTestDb();
    const unrec = await readyDraft(raw2, { prog: program({ unrecognised: [{ clause_id: "L3", text: "moon", span: [0, 4] }] }) });
    expect(await blockedBy(raw2, unrec)).toBeNull();
  });

  it("blocks only when no rule at all could be built", async () => {
    const raw = await createTestDb();
    const none = await readyDraft(raw, { prog: program({ conditions: [], sets: [], actions: [] }) });
    expect(await blockedBy(raw, none)).toMatch(/no part of the prompt could be turned into a rule/);
  });

  it("stores the fully resolved 4-slot JSON with the prompt version", async () => {
    const raw = await createTestDb();
    const id = await readyDraft(raw);
    const { promptId } = await confirmDraft(raw, id, "2026-10-02", fakeScreenFetch([]) as any);
    const row = await prep(raw, "SELECT resolved_json FROM prompts WHERE prompt_id = ?").get(promptId) as any;
    const r = JSON.parse(row.resolved_json);
    expect(r.conditions.map((c: any) => c.id)).toEqual(["C1", "C2"]);
    expect(r.conditions[1]).toMatchObject({ operator: "flips_long", parameter: { name: "vstop", args: { length: 10, mult: 2 } } });
  });

  it("stores the program itself, derives the structure, and records each condition's origin from phrases and answers", async () => {
    const raw = await createTestDb();
    const prog = program({
      source_phrases: [
        { path: "conditions.C1.value.0", phrase: "10K", span: [0, 3] }, { path: "conditions.C1.value.1", phrase: "50K", span: [4, 7] },
        { path: "conditions.C2.params.length", phrase: "10", span: [8, 10] }, { path: "conditions.C2.params.mult", phrase: "2", span: [11, 12] },
        { path: "conditions.C2.params.source", phrase: "close", span: [13, 18] },
      ],
      answers: [{ path: "conditions.C2.params.source" }, { path: "liquidity" }],   // C2's source was answered by the user
    });
    const draftId = await readyDraft(raw, { prog });
    const { promptId } = await confirmDraft(raw, draftId, "2026-10-02", fakeScreenFetch([]) as any);
    const row = await prep(raw, "SELECT structure, spec_json FROM prompts WHERE prompt_id = ?").get(promptId) as any;
    expect(row.structure).toBe("literal");
    expect(JSON.parse(row.spec_json).program_version).toBe(5);
    const conds = await prep(raw, "SELECT cond_no, role, kind, name, value_origin, source_phrase FROM prompt_conditions WHERE prompt_id = ? ORDER BY cond_no").all(promptId) as any[];
    expect(conds).toEqual([
      { cond_no: 1, role: "filter", kind: "field", name: "mcap_cr", value_origin: "prompt", source_phrase: "10K / 50K" },
      { cond_no: 2, role: "event", kind: "indicator", name: "vstop", value_origin: "user_answer", source_phrase: null },
    ]);
  });

  it("registers the arm with the program, not a v4 spec", async () => {
    const raw = await createTestDb();
    const draftId = await readyDraft(raw);
    const fetchFn = vi.fn().mockImplementation(async (url: string) => ({
      ok: true, text: async () => JSON.stringify(/\/screen$/.test(url) ? { candidates: [], applied_steps: [], funnel: [], sector_view: [] } : /\/select$/.test(url) ? { entered: [], not_confirmed: [], no_point_data: [], watching: [] } : { status: "active" }),
    }));
    await confirmDraft(raw, draftId, "2026-10-02", fetchFn as any);
    const reg = fetchFn.mock.calls.find((c) => /arms\/register/.test(c[0]))!;
    const body = JSON.parse(reg[1].body);
    expect(body.program.program_version).toBe(5);
    expect(body.spec).toBeUndefined();
  });
});
