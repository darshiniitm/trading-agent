import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { createDraft, updateDraft } from "@/server/drafts";
import { confirmDraft } from "@/server/confirm";
import { getWatchlistView } from "@/server/watchlists";

const SPEC = {
  spec_version: 4, structure: "literal" as const, timeframe: "1W" as const,
  selection_point: { session_of_week: 1, at: "open" as const },
  conditions: [{ id: "C1", role: "filter" as const, kind: "field" as const, name: "mcap_cr", params: {}, op: "between", value: [10000, 50000] }],
  stop: null, risk_cap_pct: null, near_miss: { max_failed: 1 },
};

async function confirmedWatchlist(fetchFn: any) {
  const raw = createTestDb();
  const userId = ensureOwnerUser(raw);
  const { draftId } = createDraft(raw, { userId });
  updateDraft(raw, draftId, {
    title: "My brief", structure: "literal", specJson: JSON.stringify(SPEC),
    hypothesis: "h", killCriterion: "k",
  });
  const { watchlistId } = await confirmDraft(raw, draftId, "2026-10-02", fetchFn);
  return { raw, watchlistId };
}

describe("getWatchlistView", () => {
  it("returns null for an unknown watchlist", () => {
    const raw = createTestDb();
    expect(getWatchlistView(raw, 999)).toBeNull();
  });

  it("assembles header, conditions, and entries across membership types", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          { ticker: "FULL1", membership: "full_match", values: { C1: 25000 }, failed_ids: [], ep: 101.5, sl: 95.0, r: 0.064 },
          { ticker: "NEAR1", membership: "near_miss", values: { C1: 9000 }, failed_ids: ["C1"], ep: 50.0, sl: null, r: null },
        ],
        applied_steps: [{ step: "evaluate_on_completed_weekly_bar", applied: true, reason: null }],
        funnel: [], sector_view: [],
      }),
    });
    const { raw, watchlistId } = await confirmedWatchlist(fetchFn);

    const view = getWatchlistView(raw, watchlistId)!;
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
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ candidates: [], applied_steps: [], funnel: [], sector_view: [] }) });
    const { raw, watchlistId } = await confirmedWatchlist(fetchFn);
    const view = getWatchlistView(raw, watchlistId)!;
    expect(view.entries).toEqual([]);
  });
});
