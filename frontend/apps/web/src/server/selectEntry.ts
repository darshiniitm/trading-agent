import type Database from "better-sqlite3";
import { selectCandidates, type SelectCandidate } from "@/server/engine/client";
import { FROZEN_STATUSES } from "@/server/weeklyScreen";

// Entry statuses a /select outcome may still be applied to: open, and not yet
// resolved (FROZEN_STATUSES are open-but-resolved; every other status is
// terminal).
const SELECTABLE_STATUSES = ["pending_selection", "no_point_data", "watching"];

type Outcome = { status: "entered" | "not_confirmed" | "no_point_data" | "watching"; entryPrice: number | null; stop: number | null; refPrice: number | null };

function outcomeFor(status: Outcome["status"], c: SelectCandidate): Outcome {
  if (status === "entered" || status === "not_confirmed") {
    return { status, entryPrice: c.entry_price ?? null, stop: c.sl ?? null, refPrice: null };
  }
  if (status === "watching") {
    return { status, entryPrice: null, stop: null, refPrice: c.ref_price ?? null };
  }
  return { status: "no_point_data", entryPrice: null, stop: null, refPrice: null };
}

export async function runSelectEntry(
  raw: Database.Database,
  { promptId, runId }: { promptId: number; runId: number },
  fetchFn?: typeof fetch
): Promise<{ updated: number }> {
  const prompt = raw.prepare("SELECT * FROM prompts WHERE prompt_id = ?").get(promptId) as any;
  if (!prompt) throw new Error(`prompt ${promptId} not found`);
  const run = raw.prepare("SELECT * FROM runs WHERE run_id = ? AND prompt_id = ?").get(runId, promptId) as any;
  if (!run) throw new Error(`run ${runId} not found for prompt ${promptId}`);
  const spec = JSON.parse(prompt.spec_json);

  const result = await selectCandidates(spec, run.as_of, promptId, run.kind === "dry_run" ? "dry_run" : "scheduled", fetchFn);

  const byTicker = new Map<string, Outcome>();
  for (const c of result.entered) byTicker.set(c.ticker, outcomeFor("entered", c));
  for (const c of result.not_confirmed) byTicker.set(c.ticker, outcomeFor("not_confirmed", c));
  for (const c of result.no_point_data) byTicker.set(c.ticker, outcomeFor("no_point_data", c));
  for (const c of result.watching) byTicker.set(c.ticker, outcomeFor("watching", c));

  const now = new Date().toISOString();
  const selectEntriesForRun = raw.prepare("SELECT entry_id, symbol, status FROM watchlist_entries WHERE last_run_id = ?");
  // entry_price (N1 fix): the resolved selection-point fill, written here
  // alongside entry_status so that validatePrior.ts can source its graded
  // picks straight from run_results — an immutable per-(run_id, symbol)
  // fact — instead of from watchlist_entries, whose rows freeze per
  // watchlist and can't reflect a symbol re-entering on a later run.
  const updateRunResult = raw.prepare("UPDATE run_results SET entry_status = ?, entry_price = ? WHERE run_id = ? AND symbol = ?");
  const updateEntry = raw.prepare(
    `UPDATE watchlist_entries
     SET status = ?, entry_price = ?, stop = ?, ref_price = COALESCE(?, ref_price),
         entry_date = CASE WHEN ? = 'entered' THEN COALESCE(entry_date, ?) ELSE entry_date END,
         updated_at = ?
     WHERE entry_id = ?`
  );
  const insertEvent = raw.prepare("INSERT INTO entry_events (entry_id, run_id, type, from_value, to_value, at) VALUES (?, ?, 'status_changed', ?, ?, ?)");

  const txn = raw.transaction(() => {
    const entriesBefore = selectEntriesForRun.all(runId) as { entry_id: number; symbol: string; status: string }[];
    const entriesByTicker = new Map<string, { entry_id: number; symbol: string; status: string }[]>();
    for (const entry of entriesBefore) {
      const list = entriesByTicker.get(entry.symbol) ?? [];
      list.push(entry);
      entriesByTicker.set(entry.symbol, list);
    }

    let applied = 0;
    for (const [ticker, outcome] of byTicker) {
      const entries = entriesByTicker.get(ticker) ?? [];
      // A pick already resolved in this run (entered / not_confirmed — the
      // same FROZEN_STATUSES weeklyScreen honours) is a historical fact:
      // re-running /select for the same run (a catch-up retry, a manual
      // re-run) must not re-price it, re-date it, or rewrite this run's
      // recorded outcome for it.
      if (entries.some((e) => FROZEN_STATUSES.includes(e.status))) continue;

      updateRunResult.run(outcome.status, outcome.entryPrice, runId, ticker);
      for (const entry of entries) {
        // Only entries still awaiting a selection outcome are updated; a
        // terminal entry (e.g. dropped_from_screen, which also carries this
        // run as its last_run_id) is never revived by a /select result.
        if (!SELECTABLE_STATUSES.includes(entry.status)) continue;
        updateEntry.run(outcome.status, outcome.entryPrice, outcome.stop, outcome.refPrice, outcome.status, run.as_of, now, entry.entry_id);
        if (outcome.status !== entry.status) {
          insertEvent.run(entry.entry_id, runId, entry.status, outcome.status, now);
        }
      }
      applied++;
    }

    return applied;
  });

  return { updated: txn() };
}
