import type { Db } from "@/server/db/pg";
import { insertMany } from "@/server/db/pg";
import { programOf } from "@/server/programOf";
import { selectCandidates, type SelectCandidate } from "@/server/engine/client";
import { task, tool } from "@/server/telemetry";
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

const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");

async function runSelectEntryImpl(
  raw: Db,
  { promptId, runId }: { promptId: number; runId: number },
  fetchFn?: typeof fetch
): Promise<{ updated: number }> {
  const prompt = await raw.get("SELECT * FROM prompts WHERE prompt_id = ?", [promptId]);
  if (!prompt) throw new Error(`prompt ${promptId} not found`);
  const run = await raw.get("SELECT * FROM runs WHERE run_id = ? AND prompt_id = ?", [runId, promptId]);
  if (!run) throw new Error(`run ${runId} not found for prompt ${promptId}`);
  const program = programOf(prompt.spec_json);

  const result = await selectCandidates(program, run.as_of, promptId, run.kind === "dry_run" ? "dry_run" : "scheduled", fetchFn);

  const byTicker = new Map<string, Outcome>();
  for (const c of result.entered) byTicker.set(c.ticker, outcomeFor("entered", c));
  for (const c of result.not_confirmed) byTicker.set(c.ticker, outcomeFor("not_confirmed", c));
  for (const c of result.no_point_data) byTicker.set(c.ticker, outcomeFor("no_point_data", c));
  for (const c of result.watching) byTicker.set(c.ticker, outcomeFor("watching", c));

  const now = new Date().toISOString();

  const txn = () => raw.tx(async (t) => {
    const entriesBefore = await t.all<{ entry_id: number; symbol: string; status: string }>("SELECT entry_id, symbol, status FROM watchlist_entries WHERE last_run_id = ?", [runId]);
    const entriesByTicker = new Map<string, { entry_id: number; symbol: string; status: string }[]>();
    for (const entry of entriesBefore) {
      const list = entriesByTicker.get(entry.symbol) ?? [];
      list.push(entry);
      entriesByTicker.set(entry.symbol, list);
    }

    let applied = 0;
    const resultRows: [string, number | null, string][] = [];
    const entryRows: [number, Outcome][] = [];
    const events: unknown[][] = [];
    for (const [ticker, outcome] of byTicker) {
      const entries = entriesByTicker.get(ticker) ?? [];
      // A pick already resolved in this run (entered / not_confirmed — the
      // same FROZEN_STATUSES weeklyScreen honours) is a historical fact:
      // re-running /select for the same run (a catch-up retry, a manual
      // re-run) must not re-price it, re-date it, or rewrite this run's
      // recorded outcome for it.
      if (entries.some((e) => FROZEN_STATUSES.includes(e.status))) continue;

      // entry_price (N1 fix): the resolved selection-point fill, written here
      // alongside entry_status so that validatePrior.ts can source its graded
      // picks straight from run_results — an immutable per-(run_id, symbol)
      // fact — instead of from watchlist_entries, whose rows freeze per
      // watchlist and can't reflect a symbol re-entering on a later run.
      resultRows.push([outcome.status, outcome.entryPrice, ticker]);
      for (const entry of entries) {
        // Only entries still awaiting a selection outcome are updated; a
        // terminal entry (e.g. dropped_from_screen, which also carries this
        // run as its last_run_id) is never revived by a /select result.
        if (!SELECTABLE_STATUSES.includes(entry.status)) continue;
        entryRows.push([entry.entry_id, outcome]);
        if (outcome.status !== entry.status) events.push([entry.entry_id, runId, "status_changed", entry.status, outcome.status, now]);
      }
      applied++;
    }

    // One statement per batch (UPDATE .. FROM VALUES) rather than one per pick, for the same round-trip reason as weeklyScreen.
    for (let i = 0; i < resultRows.length; i += 3000) {
      const part = resultRows.slice(i, i + 3000);
      await t.run(
        `UPDATE run_results rr SET entry_status = v.st, entry_price = v.ep
         FROM (VALUES ${part.map(() => "(?::text, ?::double precision, ?::text)").join(", ")}) AS v(st, ep, sym)
         WHERE rr.run_id = ? AND rr.symbol = v.sym`,
        [...part.flat(), runId]);
    }
    for (let i = 0; i < entryRows.length; i += 3000) {
      const part = entryRows.slice(i, i + 3000);
      await t.run(
        `UPDATE watchlist_entries e
         SET status = v.st, entry_price = v.ep, stop = v.sl, ref_price = COALESCE(v.rp, e.ref_price),
             entry_date = CASE WHEN v.st = 'entered' THEN COALESCE(e.entry_date, CAST(? AS date)) ELSE e.entry_date END,
             updated_at = CAST(? AS timestamptz)
         FROM (VALUES ${part.map(() => "(?::bigint, ?::text, ?::double precision, ?::double precision, ?::double precision)").join(", ")}) AS v(id, st, ep, sl, rp)
         WHERE e.entry_id = v.id`,
        [run.as_of, now, ...part.flatMap(([id, o]) => [id, o.status, o.entryPrice, o.stop, o.refPrice])]);
    }
    await insertMany(t, "entry_events", ["entry_id", "run_id", "type", "from_value", "to_value", "at"], events);

    return applied;
  });

  return { updated: await tool("warehouse.write", txn, { argsOf: () => ({ tables: "run_results, watchlist_entries, entry_events" }), captureOutput: false })() };
}

// observability: entry selection for one run
export const runSelectEntry = task("select_entry", runSelectEntryImpl);
