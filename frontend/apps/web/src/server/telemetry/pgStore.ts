// Postgres (Supabase) run-record writer. Rows are queued in memory and written in the background, so a slow or dead
// database can never slow down or fail a prompt run:
//   · bounded FIFO queue (drop-oldest, counted)       · batched multi-row INSERTs, idempotent on (trace_id, span_id)
//   · circuit breaker with exponential backoff        · data errors (22/23/42) drop only the bad row, connectivity errors requeue
//   · timers are unref()'d; close() drains and ends the pool.
// Unnamed queries only (Supabase's transaction-mode pooler rejects prepared statements). Server-only: never import from the Edge runtime.
import { Pool } from "pg";
import { redactString } from "./redact";
import { noopStore, type AgentRow, type RunRow, type RunStore, type TaskRow, type ToolRow } from "./store";

export type PoolLike = { query(text: string, params?: unknown[]): Promise<unknown>; end(): Promise<void> };
export type PgStoreOpts = {
  connectionString?: string;
  poolFactory?: (connectionString: string, opts: object) => PoolLike;
  flushMs?: number; batchSize?: number; maxQueue?: number;
  failureThreshold?: number; backoffBaseMs?: number; backoffMaxMs?: number;
  onDrop?: (n: number) => void;
};

type Table = "runs" | "run_tasks" | "agent_calls" | "tool_calls";
type Item = { table: Table; row: Record<string, unknown> };

const COLS: Record<Table, string[]> = {
  runs: ["run_id", "trace_id", "kind", "draft_id", "prompt_id", "user_hash", "provider", "model", "status", "outcome", "started_at", "ended_at", "duration_ms", "rows_in", "rows_out", "error_type", "error_msg", "code_version", "attrs"],
  run_tasks: ["run_id", "trace_id", "span_id", "parent_span_id", "task_id", "task_name", "seq", "status", "started_at", "ended_at", "duration_ms", "rows_in", "rows_out", "input", "output", "truncated", "error_type", "error_msg"],
  agent_calls: ["run_id", "trace_id", "span_id", "parent_span_id", "task_span_id", "agent_name", "agent_version", "model", "provider", "input_tokens", "output_tokens", "gpu_ms", "status", "started_at", "ended_at", "duration_ms", "input", "output", "truncated", "error_type", "error_msg"],
  tool_calls: ["run_id", "trace_id", "span_id", "parent_span_id", "agent_span_id", "tool_name", "tool_args", "rows_in", "rows_out", "model", "provider", "input_tokens", "output_tokens", "gpu_ms", "status", "started_at", "ended_at", "duration_ms", "input", "output", "truncated", "error_type", "error_msg"],
};
const JSONB = new Set(["input", "output", "tool_args", "attrs"]);
const ORDER: Table[] = ["runs", "run_tasks", "agent_calls", "tool_calls"];     // a run row precedes its children
const MERGE_KEEP_FIRST = new Set(["run_id", "trace_id", "started_at"]);

const param = (col: string, v: unknown) => (v === undefined ? null : JSONB.has(col) && v !== null ? JSON.stringify(v) : v);

function insertSql(table: Table, rows: Record<string, unknown>[]): { sql: string; params: unknown[] } {
  const cols = COLS[table];
  const params: unknown[] = [];
  // Late partial run updates omit status / started_at (null): on conflict `coalesce` keeps the stored value. A partial update for
  // a run whose first upsert was lost violates NOT NULL (23502) and is dropped as a poison row.
  const tuples = rows.map((r) => `(${cols.map((c) => { params.push(param(c, r[c])); return `$${params.length}${JSONB.has(c) ? "::jsonb" : ""}`; }).join(", ")})`);
  const head = `insert into observability.${table} (${cols.join(", ")}) values ${tuples.join(", ")}`;
  if (table !== "runs") return { sql: `${head} on conflict (trace_id, span_id) do nothing`, params };
  // later upserts only fill in / advance fields; run_id is never changed and started_at only moves earlier
  const sets = cols.filter((c) => !["run_id", "trace_id", "started_at", "attrs"].includes(c)).map((c) => `${c} = coalesce(excluded.${c}, observability.runs.${c})`);
  // the engine may create the run row first (placeholder started_at = now): the earliest start wins
  sets.push("started_at = least(excluded.started_at, observability.runs.started_at)");
  sets.push("attrs = observability.runs.attrs || excluded.attrs");
  return { sql: `${head} on conflict (trace_id) do update set ${sets.join(", ")}`, params };
}

// one statement cannot update the same run twice: merge the batch's upserts per trace first
function mergeRuns(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const by = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const cur = by.get(r.trace_id as string);
    if (!cur) { by.set(r.trace_id as string, { ...r, attrs: r.attrs ?? {} }); continue; }
    for (const [k, v] of Object.entries(r)) {
      if (v === undefined || v === null) continue;
      if (MERGE_KEEP_FIRST.has(k)) continue;
      cur[k] = k === "attrs" ? { ...(cur.attrs as object), ...(v as object) } : v;
    }
  }
  return [...by.values()];
}

const isDataError = (e: unknown) => /^(22|23|42)/.test(String((e as { code?: unknown })?.code ?? ""));

export function createPgStore(o: PgStoreOpts): RunStore {
  const flushMs = o.flushMs ?? 1000, batchSize = o.batchSize ?? 100, maxQueue = o.maxQueue ?? 5000;
  const threshold = o.failureThreshold ?? 3, backoffBase = o.backoffBaseMs ?? 30_000, backoffMax = o.backoffMaxMs ?? 300_000;
  let pool: PoolLike | undefined;
  const getPool = () => (pool ??= (o.poolFactory ?? ((cs, opts) => new Pool({ connectionString: cs, ...opts }) as unknown as PoolLike))(o.connectionString ?? "", {
    max: 2, connectionTimeoutMillis: 3000, statement_timeout: 5000, idleTimeoutMillis: 30_000,
    ...(process.env.TELEMETRY_DB_SSL === "no-verify" ? { ssl: { rejectUnauthorized: false } } : {}),
  }));

  let queue: Item[] = [];
  let failures = 0, opens = 0, openUntil = 0, warned = false;
  let chain: Promise<void> = Promise.resolve();
  let closed = false;

  const drop = (n: number) => { if (n > 0) try { o.onDrop?.(n); } catch { /* sink */ } };
  const enqueue = (table: Table, row: unknown) => {
    if (closed) return;
    queue.push({ table, row: row as Record<string, unknown> });
    if (queue.length > maxQueue) { const n = queue.length - maxQueue; queue = queue.slice(n); drop(n); }
    if (queue.length >= batchSize) void store.flush();
  };

  const warn = (e: unknown) => { try { console.warn(`[telemetry] run-store write failed: ${redactString((e as Error)?.message ?? String(e)).slice(0, 300)}`); } catch { /* */ } };

  async function writeBatch(batch: Item[]): Promise<void> {
    const p = getPool();
    for (const table of ORDER) {
      const rows = batch.filter((i) => i.table === table).map((i) => i.row);
      if (!rows.length) continue;
      const { sql, params } = insertSql(table, table === "runs" ? mergeRuns(rows) : rows);
      try { await p.query(sql, params); }
      catch (e) {
        if (!isDataError(e)) throw e;
        for (const r of rows) {                                   // isolate the poison row(s); keep the rest
          const one = insertSql(table, [r]);
          try { await p.query(one.sql, one.params); } catch (e2) { if (!isDataError(e2)) throw e2; drop(1); warn(e2); }
        }
      }
    }
  }

  async function drain(): Promise<void> {
    while (queue.length && Date.now() >= openUntil) {
      const batch = queue.slice(0, batchSize);
      queue = queue.slice(batch.length);
      try {
        await writeBatch(batch);
        failures = 0; opens = 0; warned = false;
      } catch (e) {                                               // connectivity: requeue at the head (bounded) and back off
        queue = [...batch, ...queue];
        if (queue.length > maxQueue) { const n = queue.length - maxQueue; queue = queue.slice(n); drop(n); }
        failures++;
        if (!warned) { warn(e); warned = true; }
        if (failures >= threshold) { opens++; openUntil = Date.now() + Math.min(backoffBase * 2 ** (opens - 1), backoffMax); warned = false; warn(new Error(`circuit open for ${Math.round((openUntil - Date.now()) / 1000)}s`)); }
        return;
      }
    }
  }

  const store: RunStore = {
    upsertRun: (row: RunRow) => enqueue("runs", row),
    insertTask: (row: TaskRow) => enqueue("run_tasks", row),
    insertAgent: (row: AgentRow) => enqueue("agent_calls", row),
    insertTool: (row: ToolRow) => enqueue("tool_calls", row),
    flush: () => (chain = chain.then(drain, drain).catch(() => {})),
    async close() {
      if (closed) return;
      if (timer) clearInterval(timer);
      await store.flush();
      closed = true;
      try { await pool?.end(); } catch { /* */ }
    },
  };
  const timer = flushMs > 0 ? setInterval(() => void store.flush(), flushMs) : undefined;
  timer?.unref?.();
  return store;
}

export function createStoreFromEnv(env: NodeJS.ProcessEnv = process.env, deps: Pick<PgStoreOpts, "poolFactory" | "onDrop"> = {}): RunStore {
  const url = env.TELEMETRY_DB_URL || env.SUPABASE_DB_URL;
  if (!url) return noopStore;
  // on Netlify nothing may run between requests, so rows are written by the per-request flush (telemetry/flush.ts), not a timer
  return createPgStore({ connectionString: url, ...(env.NETLIFY ? { flushMs: 0 } : {}), ...deps, poolFactory: deps.poolFactory ? (cs, opts) => deps.poolFactory!(cs, opts) : undefined });
}
