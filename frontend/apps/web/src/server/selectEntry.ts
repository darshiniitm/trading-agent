import type Database from "better-sqlite3";
import { selectCandidates, type SelectCandidate } from "@/server/engine/client";

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
  const updateRunResult = raw.prepare("UPDATE run_results SET entry_status = ? WHERE run_id = ? AND symbol = ?");
  const updateEntry = raw.prepare(
    `UPDATE watchlist_entries
     SET status = ?, entry_price = ?, stop = ?, ref_price = COALESCE(?, ref_price),
         entry_date = CASE WHEN ? = 'entered' THEN COALESCE(entry_date, ?) ELSE entry_date END,
         updated_at = ?
     WHERE last_run_id = ? AND symbol = ?`
  );
  const insertEvent = raw.prepare("INSERT INTO entry_events (entry_id, run_id, type, from_value, to_value, at) VALUES (?, ?, 'status_changed', ?, ?, ?)");

  const txn = raw.transaction(() => {
    const entriesBefore = selectEntriesForRun.all(runId) as { entry_id: number; symbol: string; status: string }[];

    for (const [ticker, outcome] of byTicker) {
      updateRunResult.run(outcome.status, runId, ticker);
      updateEntry.run(outcome.status, outcome.entryPrice, outcome.stop, outcome.refPrice, outcome.status, run.as_of, now, runId, ticker);
    }

    for (const entry of entriesBefore) {
      const outcome = byTicker.get(entry.symbol);
      if (outcome && outcome.status !== entry.status) {
        insertEvent.run(entry.entry_id, runId, entry.status, outcome.status, now);
      }
    }

    return byTicker.size;
  });

  return { updated: txn() };
}
