import type Database from "better-sqlite3";
import { screen } from "@/server/engine/client";

function statusFor(membership: string): string {
  return membership === "full_match" ? "pending_selection" : "watching";
}

function remapKeysToCondNo(values: Record<string, unknown>, idToCondNo: Record<string, number>) {
  const out: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(values)) {
    const condNo = idToCondNo[id];
    if (condNo !== undefined) out[`C${condNo}`] = value;
  }
  return out;
}

function remapIdsToCondNo(ids: string[], idToCondNo: Record<string, number>): string[] {
  return ids.filter((id) => idToCondNo[id] !== undefined).map((id) => `C${idToCondNo[id]}`);
}

const OPEN_STATUSES = ["pending_selection", "entered", "not_confirmed", "no_point_data", "watching"];

export async function runWeeklyScreen(
  raw: Database.Database,
  { promptId, asOf, kind }: { promptId: number; asOf: string; kind: "scheduled" | "catch_up" },
  fetchFn?: typeof fetch
): Promise<{ runId: number }> {
  const prompt = raw.prepare("SELECT * FROM prompts WHERE prompt_id = ?").get(promptId) as any;
  if (!prompt) throw new Error(`prompt ${promptId} not found`);
  const spec = JSON.parse(prompt.spec_json);

  const idToCondNo: Record<string, number> = {};
  (raw.prepare("SELECT cond_no, name FROM prompt_conditions WHERE prompt_id = ? ORDER BY cond_no").all(promptId) as any[]).forEach((row, i) => {
    // The engine's own condition.id (e.g. "idMcap") is only known from the
    // spec, not from prompt_conditions (which stores name/cond_no, not the
    // original id string) — spec.conditions is written in the same cond_no
    // order at confirm time (Task 8, Phase 1), so zipping by index is exact.
    idToCondNo[spec.conditions[i].id] = row.cond_no;
  });

  const screenResult = await screen(spec, asOf, fetchFn);
  const now = new Date().toISOString();

  const txn = raw.transaction(() => {
    const runInfo = raw
      .prepare(
        `INSERT INTO runs (prompt_id, as_of, kind, status, applied_steps_json, funnel_json, finished_at)
         VALUES (?, ?, ?, 'done', ?, ?, ?)`
      )
      .run(promptId, asOf, kind, JSON.stringify(screenResult.applied_steps), JSON.stringify(screenResult.funnel), now);
    const runId = Number(runInfo.lastInsertRowid);

    const insertSymbol = raw.prepare(`INSERT OR IGNORE INTO symbols (symbol, active) VALUES (?, 1)`);
    const insertRunResult = raw.prepare(
      `INSERT INTO run_results
         (run_id, symbol, membership, in_forward_record, failed_conds_json, cond_json, metrics_json,
          ep, sl, ref_price, confidence, entry_status)
       VALUES (?, ?, ?, 0, ?, ?, NULL, ?, ?, ?, NULL, ?)`
    );
    const watchlistIds = (raw.prepare("SELECT watchlist_id FROM watchlists WHERE prompt_id = ? AND archived_at IS NULL").all(promptId) as { watchlist_id: number }[]).map((r) => r.watchlist_id);

    const selectOpenEntry = raw.prepare(
      `SELECT entry_id, membership, status FROM watchlist_entries WHERE watchlist_id = ? AND symbol = ? AND status IN (${OPEN_STATUSES.map(() => "?").join(",")})`
    );
    const insertEntry = raw.prepare(
      `INSERT INTO watchlist_entries (watchlist_id, symbol, first_run_id, last_run_id, membership, status, ref_price, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const updateEntryMembership = raw.prepare(
      `UPDATE watchlist_entries SET last_run_id = ?, membership = ?, updated_at = ? WHERE entry_id = ?`
    );
    const dropEntry = raw.prepare(
      `UPDATE watchlist_entries SET status = 'dropped_from_screen', last_run_id = ?, updated_at = ? WHERE entry_id = ?`
    );
    const insertEvent = raw.prepare(
      `INSERT INTO entry_events (entry_id, run_id, type, from_value, to_value, at) VALUES (?, ?, ?, ?, ?, ?)`
    );

    const seenSymbols = new Set<string>();
    for (const candidate of screenResult.candidates) {
      seenSymbols.add(candidate.ticker);
      insertSymbol.run(candidate.ticker);

      const entryStatus = statusFor(candidate.membership);
      const condJson = remapKeysToCondNo(candidate.values, idToCondNo);
      const failedCondsJson = remapIdsToCondNo(candidate.failed_ids, idToCondNo);

      insertRunResult.run(
        runId, candidate.ticker, candidate.membership, JSON.stringify(failedCondsJson), JSON.stringify(condJson),
        candidate.membership === "full_match" ? candidate.ep : null,
        candidate.membership === "full_match" ? candidate.sl : null,
        candidate.membership === "full_match" ? null : candidate.ep,
        entryStatus
      );

      for (const watchlistId of watchlistIds) {
        const existing = selectOpenEntry.get(watchlistId, candidate.ticker, ...OPEN_STATUSES) as any;
        if (!existing) {
          insertEntry.run(watchlistId, candidate.ticker, runId, runId, candidate.membership, entryStatus,
            candidate.membership === "full_match" ? null : candidate.ep, now, now);
        } else {
          if (existing.membership !== candidate.membership) {
            insertEvent.run(existing.entry_id, runId, "membership_changed", existing.membership, candidate.membership, now);
          }
          updateEntryMembership.run(runId, candidate.membership, now, existing.entry_id);
        }
      }
    }

    // Open entries not re-seen this run: dropped, per watchlist.
    for (const watchlistId of watchlistIds) {
      const openEntries = raw
        .prepare(`SELECT entry_id, symbol, status FROM watchlist_entries WHERE watchlist_id = ? AND status IN (${OPEN_STATUSES.map(() => "?").join(",")})`)
        .all(watchlistId, ...OPEN_STATUSES) as { entry_id: number; symbol: string; status: string }[];
      for (const entry of openEntries) {
        if (!seenSymbols.has(entry.symbol)) {
          dropEntry.run(runId, now, entry.entry_id);
          insertEvent.run(entry.entry_id, runId, "dropped_from_screen", entry.status, "dropped_from_screen", now);
        }
      }
    }

    return runId;
  });

  return { runId: txn() };
}
