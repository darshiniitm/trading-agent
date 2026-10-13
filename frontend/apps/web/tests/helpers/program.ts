import type Database from "better-sqlite3";
import type { ScreenProgram } from "spec";
import { createDraft, saveProgramState, updateDraft } from "@/server/drafts";
import { ensureOwnerUser } from "@/server/db/seed";

// A fully answered v5 program: market cap + a weekly VStop flip, one set with near-miss tolerance, a trade
// plan whose stop comes from the VStop, liquidity answered "no filter". Every value came from the user.
export function program(overrides: Partial<ScreenProgram> = {}): ScreenProgram {
  return {
    program_version: 5, universe: { source: "nse_all" },
    sets: [{ id: "S1", from: "universe", label: "brief", eval: { mode: "literal", timeframe: "1W", bar: "last_completed" }, where: { all: ["C1", "C2"] }, near_miss: { max_failed: 1 } }],
    conditions: [
      { id: "C1", lhs: { field: "mcap_cr" }, op: "between", value: [10000, 50000], phrase: "between 10K-50K cr" },
      { id: "C2", lhs: { ind: "vstop", params: { length: 10, mult: 2, source: "close" }, tf: "1W" }, op: "flip", dir: "long", within_bars: 1, phrase: "flipped on VStop 10,2" },
    ],
    actions: [{ id: "A1", type: "trade_plan", set: "S1", entry: { at: "next_open" }, stop: { from: "C2" }, confidence: { method: "conditions_met_count" } }],
    source_phrases: [], needs_input: [], unsupported: [], ignored: [], unrecognised: [],
    answers: [
      { path: "conditions.C1.value.0" }, { path: "conditions.C1.value.1" },
      { path: "conditions.C2.params.length" }, { path: "conditions.C2.params.mult" }, { path: "conditions.C2.params.source" },
      { path: "liquidity" },
    ],
    ...overrides,
  } as ScreenProgram;
}

// A draft that is ready to confirm (program answered, hypothesis and kill criterion present).
export function readyDraft(raw: Database.Database, { prog = program(), ...patch }: { prog?: ScreenProgram; [k: string]: unknown } = {}) {
  const userId = ensureOwnerUser(raw);
  const { draftId } = createDraft(raw, { userId });
  updateDraft(raw, draftId, { title: "Original brief", promptText: "All stocks between 10K-50K cr", hypothesis: "mid-caps in an uptrend outperform", killCriterion: "negative expectancy after 13 weeks", ...(patch as object) });
  saveProgramState(raw, draftId, { program: prog, clauses: [], normalised: "" });
  return draftId;
}
