import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { createDraft, updateDraft } from "@/server/drafts";
import { confirmDraft } from "@/server/confirm";
import { getWatchlistView } from "@/server/watchlists";

import { program, readyDraft } from "./helpers/program";

const MCAP_ONLY = program({
  sets: [{ id: "S1", from: "universe", where: { all: ["C1"] }, near_miss: { max_failed: 1 } }],
  conditions: [{ id: "C1", lhs: { field: "mcap_cr" }, op: "between", value: [10000, 50000] }],
  actions: [],
});

async function confirmedWatchlist(fetchFn: any) {
  const raw = await createTestDb();
  const draftId = await readyDraft(raw, { prog: MCAP_ONLY, title: "My brief", hypothesis: "h", killCriterion: "k" });
  const { watchlistId } = await confirmDraft(raw, draftId, "2026-10-02", fetchFn);
  return { raw, watchlistId };
}

describe("getWatchlistView", () => {
  it("returns null for an unknown watchlist", async () => {
    const raw = await createTestDb();
    expect(await getWatchlistView(raw, 999)).toBeNull();
  });

  it("assembles header, conditions, and entries across membership types", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        candidates: [
          { ticker: "FULL1", membership: "full_match", values: { C1: 25000 }, failed_ids: [], ep: 101.5, sl: 95.0, r: 0.064 },
          { ticker: "NEAR1", membership: "near_miss", values: { C1: 9000 }, failed_ids: ["C1"], ep: 50.0, sl: null, r: null },
        ],
        applied_steps: [{ step: "evaluate_on_completed_weekly_bar", applied: true, reason: null }],
        funnel: [], sector_view: [],
      }),
    });
    const { raw, watchlistId } = await confirmedWatchlist(fetchFn);

    const view = (await getWatchlistView(raw, watchlistId))!;
    expect(view.title).toBe("My brief");
    expect(view.hasRiskCap).toBe(false);
    expect(view.conditions).toHaveLength(1);
    expect(view.conditions[0].valueOrigin).toBe("user_answer");
    expect(view.lastRun?.asOf).toBe("2026-10-02");

    const bySymbol = Object.fromEntries(view.entries.map((e) => [e.symbol, e]));
    expect(bySymbol.FULL1.membership).toBe("full_match");
    expect(bySymbol.FULL1.condValues).toEqual({ C1: 25000 });
    expect(bySymbol.NEAR1.membership).toBe("near_miss");
    expect(bySymbol.NEAR1.failedIds).toEqual(["C1"]);
  });

  it("handles a watchlist whose latest run had zero candidates", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ candidates: [], applied_steps: [], funnel: [], sector_view: [] }) });
    const { raw, watchlistId } = await confirmedWatchlist(fetchFn);
    const view = (await getWatchlistView(raw, watchlistId))!;
    expect(view.entries).toEqual([]);
  });

  it("assembles every entry correctly at real-world scale (same statement-per-row crash class as confirm.ts)", async () => {
    const CANDIDATE_COUNT = 300;
    const candidates = Array.from({ length: CANDIDATE_COUNT }, (_, i) => ({
      ticker: `TICK${i}`, membership: "full_match", values: { C1: 20000 + i }, failed_ids: [], ep: 100 + i, sl: 90 + i, r: 10,
    }));
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true, text: async () => JSON.stringify({ candidates, applied_steps: [], funnel: [], sector_view: [] }),
    });
    const { raw, watchlistId } = await confirmedWatchlist(fetchFn);
    const view = (await getWatchlistView(raw, watchlistId))!;
    expect(view.entries).toHaveLength(CANDIDATE_COUNT);
    expect(view.entries.every((e) => e.condValues.C1 !== undefined)).toBe(true);
  });
});
