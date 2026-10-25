import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { runWeeklyScreen } from "@/server/weeklyScreen";
import { prep } from "./helpers/prep";

const SPEC = {
  spec_version: 4, structure: "literal" as const, timeframe: "1W" as const,
  selection_point: { session_of_week: 1, at: "open" as const },
  conditions: [{ id: "idMcap", role: "filter" as const, kind: "field" as const, name: "mcap_cr", params: {}, op: "between", value: [10000, 50000] }],
  stop: null, risk_cap_pct: null, near_miss: null,
};

async function seed() {
  const raw = await createTestDb();
  const owner = await ensureOwnerUser(raw);
  const now = "2026-10-01T00:00:00.000Z";
  await prep(raw, `INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (1, ?, 'x', 'confirmed', ?, ?)`).run(owner, now, now);
  await prep(raw, 
    `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, confirmed_at)
     VALUES (1, ?, 1, 'P', 'x', 'literal', ?, 'h', 'confirmed', 1, 'h', 'k', ?)`
  ).run(owner, JSON.stringify(SPEC), now);
  await prep(raw, `INSERT INTO prompt_conditions (prompt_id, cond_no, role, kind, name, op, value_origin) VALUES (1, 1, 'filter', 'field', 'mcap_cr', 'between', 'user_answer')`).run();
  await prep(raw, `INSERT INTO watchlists (watchlist_id, user_id, prompt_id, name, created_at) VALUES (1, ?, 1, 'wl', ?)`).run(owner, now);
  return raw;
}

const screenBody = (over: object = {}) => ({
  candidates: [
    { ticker: "OK1", membership: "full_match", values: {}, failed_ids: [], ep: 100, sl: 95, r: 5 },
    { ticker: "NEAR1", membership: "near_miss", values: {}, failed_ids: ["idMcap"], ep: 90, sl: null, r: null },
  ],
  applied_steps: [], funnel: [], sector_view: [],
  run_coverage: { universe_size: 10, fully_evaluated: 8, coverage: 0.8, status: "partial", scored: false, universe_quality: "approx",
                  unfeedable_conditions: ["idSector"], per_condition: { idMcap: 0.9, idSector: 0 } },
  unevaluated: [{ ticker: "NEW1", set: "S1", reasons: ["insufficient_history"], unknown_count: 1, met_count: 0, conditions: { idMcap: { state: "?", reason: "insufficient_history" } } }],
  provenance: { summary: [{ data_type: "UNIVERSE", source: "rule_approx", as_of: "2026-10-02", quality: "approx", reason: "approx_input" },
                          { data_type: "OHLCV", counts: { ok: 8, stale: 1 } }],
                rows: [{ data_type: "OHLCV", symbol: "OLD1", source: "cache:yahoo", as_of: "2026-09-20", quality: "stale", reason: "stale_data" }] },
  ...over,
});
const fetchOf = (body: object) => vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify(body) });

describe("runWeeklyScreen persists data coverage (spec §7-§8)", () => {
  it("stores status, coverage, universe quality and scored=0 for a partial run", async () => {
    const raw = await seed();
    const { runId } = await runWeeklyScreen(raw, { promptId: 1, asOf: "2026-10-02", kind: "scheduled" }, fetchOf(screenBody()) as any);
    expect(await prep(raw, "SELECT status, coverage_status, coverage, universe_quality, scored FROM runs WHERE run_id = ?").get(runId))
      .toEqual({ status: "done", coverage_status: "partial", coverage: 0.8, universe_quality: "approx", scored: 0 });
  });

  it("stores per-condition coverage with the unfeedable flag", async () => {
    const raw = await seed();
    const { runId } = await runWeeklyScreen(raw, { promptId: 1, asOf: "2026-10-02", kind: "scheduled" }, fetchOf(screenBody()) as any);
    expect(await prep(raw, "SELECT condition_id, coverage, unfeedable FROM run_condition_coverage WHERE run_id = ? ORDER BY condition_id").all(runId))
      .toEqual([{ condition_id: "idMcap", coverage: 0.9, unfeedable: 0 }, { condition_id: "idSector", coverage: 0, unfeedable: 1 }]);
  });

  it("stores provenance: a summary row per data type and per-symbol rows only when not ok", async () => {
    const raw = await seed();
    const { runId } = await runWeeklyScreen(raw, { promptId: 1, asOf: "2026-10-02", kind: "scheduled" }, fetchOf(screenBody()) as any);
    const rows = await prep(raw, "SELECT data_type, symbol, source, quality, reason FROM run_provenance WHERE run_id = ? ORDER BY data_type, symbol").all(runId) as any[];
    expect(rows).toContainEqual({ data_type: "UNIVERSE", symbol: null, source: "rule_approx", quality: "approx", reason: "approx_input" });
    expect(rows).toContainEqual({ data_type: "OHLCV", symbol: "OLD1", source: "cache:yahoo", quality: "stale", reason: "stale_data" });
    expect(rows.filter((r) => r.data_type === "OHLCV" && r.symbol === null)).toHaveLength(1);
    expect(rows.filter((r) => r.symbol !== null && r.quality === "ok")).toHaveLength(0);
  });

  it("stores unevaluated stocks with their reasons, and outcomes on candidates", async () => {
    const raw = await seed();
    const { runId } = await runWeeklyScreen(raw, { promptId: 1, asOf: "2026-10-02", kind: "scheduled" }, fetchOf(screenBody()) as any);
    const u = await prep(raw, "SELECT symbol, set_id, unknown_count, reasons_json FROM run_unevaluated WHERE run_id = ?").get(runId) as any;
    expect(u).toMatchObject({ symbol: "NEW1", set_id: "S1", unknown_count: 1 });
    expect(JSON.parse(u.reasons_json)).toEqual(["insufficient_history"]);
    const out = await prep(raw, "SELECT symbol, outcome, unknown_count FROM run_results WHERE run_id = ? ORDER BY symbol").all(runId);
    expect(out).toEqual([{ symbol: "NEAR1", outcome: "rejected", unknown_count: 0 }, { symbol: "OK1", outcome: "qualified", unknown_count: 0 }]);
    // an unevaluated stock never becomes a watchlist entry
    expect(await prep(raw, "SELECT symbol FROM watchlist_entries ORDER BY symbol").all()).toEqual([{ symbol: "NEAR1" }, { symbol: "OK1" }]);
  });

  it("a complete run is scored=1", async () => {
    const raw = await seed();
    const body = screenBody({ run_coverage: { universe_size: 10, fully_evaluated: 10, coverage: 1, status: "complete", scored: true, universe_quality: "ok", unfeedable_conditions: [], per_condition: {} } });
    const { runId } = await runWeeklyScreen(raw, { promptId: 1, asOf: "2026-10-02", kind: "scheduled" }, fetchOf(body) as any);
    expect(await prep(raw, "SELECT coverage_status, scored FROM runs WHERE run_id = ?").get(runId)).toEqual({ coverage_status: "complete", scored: 1 });
  });

  it("an older engine response without coverage still works and leaves the columns null", async () => {
    const raw = await seed();
    const { runId } = await runWeeklyScreen(raw, { promptId: 1, asOf: "2026-10-02", kind: "scheduled" },
      fetchOf({ candidates: [], applied_steps: [], funnel: [], sector_view: [] }) as any);
    expect(await prep(raw, "SELECT coverage_status, scored FROM runs WHERE run_id = ?").get(runId)).toEqual({ coverage_status: null, scored: null });
  });
});
