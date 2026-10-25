import { describe, expect, it, vi, beforeEach } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { getRecentCloses, _resetClosesCacheForTests } from "@/server/closes";
import { seriesParamsFor, getEntrySeries } from "@/server/entrySeries";
import { getValidationCaptions } from "@/server/validations";
import { getWatchlistView } from "@/server/watchlists";
import { storedConditionLabel, ruleLine } from "@/lib/conditionLabel";

beforeEach(async () => _resetClosesCacheForTests());

async function seed() {
  const raw = await createTestDb();
  const owner = await ensureOwnerUser(raw);
  const spec = JSON.stringify({ spec_version: 4, structure: "literal", timeframe: "1W", selection_point: null, conditions: [], stop: null, risk_cap_pct: null, near_miss: null });
  await prep(raw, "INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (1, ?, 'src', 'confirmed', 'x', 'x')").run(owner);
  await prep(raw, "INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, confirmed_at) VALUES (1, ?, 1, 'T', 'my prompt', 'literal', ?, 'h', 'confirmed', 2, 'h', 'k', '2026-09-26')").run(owner, spec);
  await prep(raw, "INSERT INTO prompt_conditions (prompt_id, cond_no, role, kind, name, params_json, op, value_json, value_origin) VALUES (1, 1, 'filter', 'indicator', 'rsi', '{\"length\":21}', 'between', '[50,65]', 'prompt')").run();
  await prep(raw, "INSERT INTO prompt_conditions (prompt_id, cond_no, role, kind, name, params_json, op, value_json, value_origin) VALUES (1, 2, 'event', 'indicator', 'vstop', '{\"length\":10,\"mult\":2,\"source\":\"close\"}', 'flips_long', NULL, 'prompt')").run();
  await prep(raw, "INSERT INTO symbols (symbol, name, sector) VALUES ('ABC.NS', 'Abc Ltd', 'Tech')").run();
  await prep(raw, "INSERT INTO runs (run_id, prompt_id, as_of, kind, status) VALUES (10, 1, '2026-10-02', 'scheduled', 'done')").run();
  await prep(raw, "INSERT INTO watchlists (watchlist_id, user_id, prompt_id, name, created_at) VALUES (5, ?, 1, 'w', 'x')").run(owner);
  await prep(raw, "INSERT INTO watchlist_entries (entry_id, watchlist_id, symbol, first_run_id, last_run_id, membership, status, created_at, updated_at) VALUES (7, 5, 'ABC.NS', 10, 10, 'full_match', 'pending_selection', 'x', 'x')").run();
  return raw;
}

describe("conditionLabel", () => {
  it("words a stored condition row the same way ruleLine words a slot", async () => {
    expect(storedConditionLabel({ name: "rsi", params: { length: 14 }, op: "between", value: [50, 65] })).toBe("RSI(14) · between 50–65");
    expect(storedConditionLabel({ name: "mcap_cr", params: {}, op: "<", value: 10000 })).toBe("Market cap (cr) · < 10000");
    expect(typeof ruleLine).toBe("function");
  });
});

describe("watchlist view (G4/G5/G7)", () => {
  it("carries header meta, row name/sector/added date, labels and validation captions", async () => {
    const raw = await seed();
    const v = (await getWatchlistView(raw, 5))!;
    expect(v).toMatchObject({ promptText: "my prompt", isOwner: true, version: 2, parentPromptId: null, confirmedAt: "2026-09-26", followers: 0 });
    expect(v.conditions[0].label).toBe("RSI(21) · between 50–65");
    expect(v.entries[0]).toMatchObject({ name: "Abc Ltd", sector: "Tech", addedAsOf: "2026-10-02", entryDate: null });
    expect(v.validation.gradedAsOf).toBe("2026-10-02");
    expect(v.validation.dueDates).toEqual({ "1": "2026-10-09", "2": "2026-10-16", "3": "2026-10-23" });
    expect((await getWatchlistView(raw, 5, 999))!.isOwner).toBe(false);
    expect(v.whatRuns.some((w) => w.label === "Risk cap: not in prompt" && !w.on)).toBe(true);
  });

  it("captions are empty when the prompt has no run", async () => {
    const raw = await createTestDb();
    expect(await getValidationCaptions(raw, 99)).toEqual({ gradedAsOf: null, dueDates: {}, controls: {} });
  });
});

describe("entry series (G3)", () => {
  it("passes the prompt's own indicator params through unchanged", async () => {
    const raw = await seed();
    expect(await seriesParamsFor(raw, 1)).toEqual({ rsiLength: 21, vstopLength: 10, vstopMult: 2, vstopSource: "close" });
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ symbol: "ABC.NS", bars: [] }) });
    await getEntrySeries(raw, 5, 7, fetchFn as any);
    const url = String(fetchFn.mock.calls[0][0]);
    expect(url).toContain("/series/ABC.NS");
    expect(url).toContain("vstop_length=10");
    expect(url).toContain("vstop_mult=2");
    expect(url).toContain("rsi_length=21");
  });
  it("returns null for an entry that isn't on that watchlist", async () => {
    expect(await getEntrySeries(await seed(), 6, 7)).toBeNull();
  });
});

describe("recent closes (G2)", () => {
  const bars = Array.from({ length: 20 }, (_, i) => ({ date: `d${i}`, close: i + 1 }));
  const mk = () => vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ symbol: "X", bars }) });

  it("returns the last 12 closes per symbol and serves a repeat from cache", async () => {
    const fetchFn = mk();
    const first = await getRecentCloses(["A", "B"], 12, fetchFn as any, "2026-10-02");
    expect(first.A).toHaveLength(12);
    expect(first.A[11]).toBe(20);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await getRecentCloses(["A", "B"], 12, fetchFn as any, "2026-10-02");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("a symbol whose engine call fails gets an empty list, not a failed request", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("down"));
    expect(await getRecentCloses(["A"], 12, fetchFn as any)).toEqual({ A: [] });
  });
});

import { setEntryNote, removeEntry } from "@/server/entryActions";
import { prep } from "./helpers/prep";
describe("entry actions", () => {
  it("saves a note and removes only for the watchlist's own user", async () => {
    const raw = await seed();
    const owner = 1;
    expect(await setEntryNote(raw, { watchlistId: 5, entryId: 7, userId: 99, note: "x" })).toBe(false);
    expect(await setEntryNote(raw, { watchlistId: 5, entryId: 7, userId: owner, note: "watch the gap" })).toBe(true);
    expect((await prep(raw, "SELECT user_note FROM watchlist_entries WHERE entry_id = 7").get() as any).user_note).toBe("watch the gap");
    expect(await removeEntry(raw, { watchlistId: 5, entryId: 7, userId: 99 })).toBe(false);
    expect(await removeEntry(raw, { watchlistId: 5, entryId: 7, userId: owner })).toBe(true);
    expect((await prep(raw, "SELECT status FROM watchlist_entries WHERE entry_id = 7").get() as any).status).toBe("removed_by_user");
    expect((await prep(raw, "SELECT to_value FROM entry_events WHERE entry_id = 7").get() as any).to_value).toBe("removed_by_user");
  });
});
