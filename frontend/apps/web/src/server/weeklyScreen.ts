import type { Db } from "@/server/db/pg";
import { insertMany } from "@/server/db/pg";
import { programOf } from "@/server/programOf";
import { screen } from "@/server/engine/client";
import { task, tool } from "@/server/telemetry";

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

// Once an entry reaches one of these, it is a resolved historical fact (the
// selection point was priced and `entry_price`/`stop` are written): no later
// weekly screen may touch its membership/status/last_run_id/prices again.
// Two reasons, both load-bearing:
//  - `watchlist_entries`' CHECK (membership = 'full_match' OR entry_price IS
//    NULL): flipping a priced entry's membership to near_miss /
//    rejected_risk_cap would violate it, abort the whole weekly transaction,
//    and make runCatchUp retry (and fail on) that same week forever.
//  - `last_run_id` of a frozen entry is the run it was resolved in — the
//    "signal run" runValidatePrior grades it under. Bumping it would move the
//    pick to a run whose as_of it was never bought at.
// Frozen entries still count as "open" for ux_entries_open (they hold the
// (watchlist, symbol) slot), so they must stay findable by selectOpenEntry —
// otherwise a re-seen symbol would fall into the insert branch and violate
// that unique index. They are simply skipped once found, and they are never
// marked dropped_from_screen either (a live position doesn't end because the
// screen stopped matching it). A new entry for the same symbol can only be
// created after the frozen one reaches a terminal status (backend plan §8.3:
// a symbol that leaves and later re-qualifies gets a NEW entry).
export const FROZEN_STATUSES = ["entered", "not_confirmed"];
const DROPPABLE_STATUSES = OPEN_STATUSES.filter((s) => !FROZEN_STATUSES.includes(s));

type ScreenResult = Awaited<ReturnType<typeof screen>>;

function chunks<T>(items: T[], size = 5000): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");

// Data coverage, provenance and the stocks the engine could not decide (spec §7-§8). Written in the same
// transaction as the run. An engine from before the data-resolution layer sends none of it; nothing is invented.
async function persistCoverage(raw: Db, runId: number, r: ScreenResult) {
  if (r.run_coverage) {
    const unfeedable = new Set(r.run_coverage.unfeedable_conditions);
    await insertMany(raw, "run_condition_coverage", ["run_id", "condition_id", "coverage", "unfeedable"],
      Object.entries(r.run_coverage.per_condition).map(([cid, c]) => [runId, cid, c, unfeedable.has(cid) ? 1 : 0]));
  }
  if (r.provenance) {
    const rows: unknown[][] = [];
    for (const s of r.provenance.summary) {
      // a per-type counts block has no single source/quality: store the worst quality seen
      const worst = s.counts ? (["missing", "approx", "stale", "fallback", "ok"].find((q) => (s.counts![q] ?? 0) > 0) ?? "ok") : s.quality;
      rows.push([runId, s.data_type, null, s.source ?? null, s.as_of ?? null, worst ?? null, s.reason ?? null]);
    }
    for (const row of r.provenance.rows) rows.push([runId, row.data_type, row.symbol, row.source, row.as_of, row.quality, row.reason]);
    await insertMany(raw, "run_provenance", ["run_id", "data_type", "symbol", "source", "as_of", "quality", "reason"], rows);
  }
  if (r.unevaluated?.length) {
    await insertMany(raw, "symbols", ["symbol", "active"], [...new Set(r.unevaluated.map((u) => u.ticker))].map((t) => [t, 1]), "ON CONFLICT DO NOTHING");
    // INSERT OR REPLACE semantics: the last row per (symbol, set) wins
    const byKey = new Map<string, unknown[]>();
    for (const u of r.unevaluated) {
      byKey.set(`${u.ticker}|${u.set ?? "S1"}`, [runId, u.ticker, u.set ?? "S1", u.unknown_count, u.met_count, JSON.stringify(u.reasons), u.conditions ? JSON.stringify(u.conditions) : null]);
    }
    await insertMany(raw, "run_unevaluated", ["run_id", "symbol", "set_id", "unknown_count", "met_count", "reasons_json", "cond_json"], [...byKey.values()],
      "ON CONFLICT (run_id, symbol, set_id) DO UPDATE SET unknown_count = excluded.unknown_count, met_count = excluded.met_count, reasons_json = excluded.reasons_json, cond_json = excluded.cond_json");
  }
}

async function runWeeklyScreenImpl(
  raw: Db,
  { promptId, asOf, kind }: { promptId: number; asOf: string; kind: "scheduled" | "catch_up" },
  fetchFn?: typeof fetch
): Promise<{ runId: number }> {
  const prompt = await raw.get("SELECT * FROM prompts WHERE prompt_id = ?", [promptId]);
  if (!prompt) throw new Error(`prompt ${promptId} not found`);
  const program = programOf(prompt.spec_json);

  const idToCondNo: Record<string, number> = {};
  (await raw.all("SELECT cond_no, name FROM prompt_conditions WHERE prompt_id = ? ORDER BY cond_no", [promptId])).forEach((row, i) => {
    // The engine's own condition.id (e.g. "idMcap") is only known from the
    // spec, not from prompt_conditions (which stores name/cond_no, not the
    // original id string) — program.conditions is written in the same cond_no
    // order at confirm time (Task 8, Phase 1), so zipping by index is exact.
    idToCondNo[program.conditions[i].id] = row.cond_no;
  });

  const screenResult = await screen(program, asOf, fetchFn, { userId: prompt.owner_user_id, promptId });
  const now = new Date().toISOString();
  const cov = screenResult.run_coverage;

  const txn = () => raw.tx(async (t) => {
    const runId = (await t.get<{ run_id: number }>(
      `INSERT INTO runs (prompt_id, as_of, kind, status, applied_steps_json, funnel_json, finished_at,
                         coverage_status, coverage, universe_quality, scored)
       VALUES (?, ?, ?, 'done', ?, ?, ?, ?, ?, ?, ?) RETURNING run_id`,
      [promptId, asOf, kind, JSON.stringify(screenResult.applied_steps), JSON.stringify(screenResult.funnel), now,
        cov?.status ?? null, cov?.coverage ?? null, cov?.universe_quality ?? null, cov ? (cov.scored ? 1 : 0) : null]))!.run_id;

    await persistCoverage(t, runId, screenResult);

    // The whole result goes in as a handful of multi-row statements: one round trip per candidate would make
    // a few hundred picks take tens of seconds against a remote database.
    const candidates = screenResult.candidates;
    await insertMany(t, "symbols", ["symbol", "active"], [...new Set(candidates.map((c) => c.ticker))].map((s) => [s, 1]), "ON CONFLICT DO NOTHING");
    await insertMany(t, "run_results",
      ["run_id", "symbol", "membership", "in_forward_record", "failed_conds_json", "cond_json", "metrics_json", "ep", "sl", "ref_price", "confidence", "entry_status", "outcome", "unknown_count"],
      candidates.map((candidate) => [
        runId, candidate.ticker, candidate.membership, 0,
        JSON.stringify(remapIdsToCondNo(candidate.failed_ids, idToCondNo)), JSON.stringify(remapKeysToCondNo(candidate.values, idToCondNo)), null,
        candidate.membership === "full_match" ? candidate.ep : null,
        candidate.membership === "full_match" ? candidate.sl : null,
        candidate.membership === "full_match" ? null : candidate.ep,
        null,
        statusFor(candidate.membership),
        // a near miss failed a known condition ("0 beats ?"); everything else passed the screen
        candidate.membership === "near_miss" ? "rejected" : "qualified",
        0,
      ]));

    const watchlistIds = (await t.all<{ watchlist_id: number }>("SELECT watchlist_id FROM watchlists WHERE prompt_id = ? AND archived_at IS NULL", [promptId])).map((r) => r.watchlist_id);
    if (watchlistIds.length > 0) {
      const openRows: { entry_id: number; watchlist_id: number; symbol: string; membership: string; status: string }[] = [];
      for (const ids of chunks(watchlistIds, 500)) {
        openRows.push(...await t.all(
          `SELECT entry_id, watchlist_id, symbol, membership, status FROM watchlist_entries WHERE watchlist_id IN (${marks(ids.length)}) AND status IN (${marks(OPEN_STATUSES.length)})`,
          [...ids, ...OPEN_STATUSES]));
      }
      const open = new Map(openRows.map((e) => [`${e.watchlist_id}|${e.symbol}`, e]));

      const newEntries: unknown[][] = [];
      const events: unknown[][] = [];
      const touched = new Map<string, number[]>();   // membership -> entry ids to bump to this run
      const seenSymbols = new Set<string>();
      for (const candidate of candidates) {
        seenSymbols.add(candidate.ticker);
        const entryStatus = statusFor(candidate.membership);
        for (const watchlistId of watchlistIds) {
          const existing = open.get(`${watchlistId}|${candidate.ticker}`);
          if (!existing) {
            newEntries.push([watchlistId, candidate.ticker, runId, runId, candidate.membership, entryStatus,
              candidate.membership === "full_match" ? null : candidate.ep, now, now]);
          } else if (FROZEN_STATUSES.includes(existing.status)) {
            // Resolved position — leave it exactly as it is (see FROZEN_STATUSES).
            continue;
          } else {
            if (existing.membership !== candidate.membership) {
              events.push([existing.entry_id, runId, "membership_changed", existing.membership, candidate.membership, now]);
            }
            const ids = touched.get(candidate.membership) ?? [];
            ids.push(existing.entry_id);
            touched.set(candidate.membership, ids);
          }
        }
      }
      await insertMany(t, "watchlist_entries", ["watchlist_id", "symbol", "first_run_id", "last_run_id", "membership", "status", "ref_price", "created_at", "updated_at"], newEntries);
      for (const [membership, ids] of touched) {
        for (const part of chunks(ids)) {
          await t.run(`UPDATE watchlist_entries SET last_run_id = ?, membership = ?, updated_at = ? WHERE entry_id IN (${marks(part.length)})`, [runId, membership, now, ...part]);
        }
      }

      // Open, not-yet-resolved entries not re-seen this run: dropped, per
      // watchlist. Frozen (entered/not_confirmed) entries are excluded whether
      // or not their symbol was re-seen.
      const droppable: { entry_id: number; symbol: string; status: string }[] = [];
      for (const ids of chunks(watchlistIds, 500)) {
        droppable.push(...await t.all(
          `SELECT entry_id, symbol, status FROM watchlist_entries WHERE watchlist_id IN (${marks(ids.length)}) AND status IN (${marks(DROPPABLE_STATUSES.length)})`,
          [...ids, ...DROPPABLE_STATUSES]));
      }
      const dropped = droppable.filter((e) => !seenSymbols.has(e.symbol));
      for (const part of chunks(dropped.map((e) => e.entry_id))) {
        await t.run(`UPDATE watchlist_entries SET status = 'dropped_from_screen', last_run_id = ?, updated_at = ? WHERE entry_id IN (${marks(part.length)})`, [runId, now, ...part]);
      }
      for (const e of dropped) events.push([e.entry_id, runId, "dropped_from_screen", e.status, "dropped_from_screen", now]);
      await insertMany(t, "entry_events", ["entry_id", "run_id", "type", "from_value", "to_value", "at"], events);
    }

    return runId;
  });

  return { runId: await tool("warehouse.write", txn, { argsOf: () => ({ tables: "runs, run_results, watchlist_entries, entry_events" }), captureOutput: false })() };
}

// observability: one task per weekly screen (scheduled, catch-up or the first run at confirm)
export const runWeeklyScreen = task("weekly_screen", runWeeklyScreenImpl);
