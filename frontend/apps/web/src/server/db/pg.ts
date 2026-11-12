import { Pool, types as pgTypes, type PoolClient } from "pg";

// The app database: Supabase Postgres, schema screener_app (db/migrations/0011_screener_app_full.sql).
//
// Rules this module enforces (docs/netlify-production-plan.md §4.2):
//  * Unnamed, parameterised queries only. The Supabase transaction pooler (port 6543) rejects prepared
//    statements, and `pg` only prepares a statement when the query has a `name`.
//  * Values reach the app code in the shapes SQLite gave it: bigint -> number, jsonb -> JSON text,
//    timestamptz -> ISO string (toISOString), date -> 'YYYY-MM-DD'. See `valueParsers`.
//  * SQL is written with `?` markers and numbered here, so dynamic IN (...) lists stay simple.

export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
  /** First row, or undefined. */
  get<T = any>(sql: string, params?: unknown[]): Promise<T | undefined>;
  all<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Rows affected. */
  run(sql: string, params?: unknown[]): Promise<number>;
  /** BEGIN .. COMMIT around fn (ROLLBACK if it throws). Inside a transaction a nested tx() is a savepoint. */
  tx<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

/** `?` -> `$1, $2, ...`, skipping single-quoted literals. Explicit $n markers are left alone. */
export function toPgPlaceholders(sql: string): string {
  let out = "";
  let n = 0;
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") inString = !inString; // a doubled '' toggles twice, so it stays inside the literal
    if (ch === "?" && !inString) out += `$${++n}`;
    else out += ch;
  }
  return out;
}

const OID = { INT8: 20, JSON: 114, TIMESTAMP: 1114, DATE: 1082, TIMESTAMPTZ: 1184, JSONB: 3802 } as const;

export function parseInstant(text: string): string {
  const iso = text.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00");
  return new Date(/(Z|[+-]\d\d:\d\d)$/i.test(iso) ? iso : `${iso}Z`).toISOString();
}

/** Shared by the pg driver (production) and PGlite (tests): oid -> text-to-value parser. */
export const valueParsers: Record<number, (text: string) => unknown> = {
  [OID.INT8]: (t) => Number(t),
  [OID.JSON]: (t) => t,
  [OID.JSONB]: (t) => t,
  [OID.DATE]: (t) => t,
  [OID.TIMESTAMPTZ]: parseInstant,
  [OID.TIMESTAMP]: parseInstant,
};

type Exec = (sql: string, params: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;

export function makeDb(exec: Exec, tx: Db["tx"]): Db {
  const query: Db["query"] = (sql, params = []) => exec(sql, params);
  return {
    query,
    get: async (sql, params) => (await query(sql, params)).rows[0],
    all: async (sql, params) => (await query(sql, params)).rows,
    run: async (sql, params) => (await query(sql, params)).rowCount,
    tx,
  };
}

/** A Db bound to one open transaction; nested tx() calls become savepoints. */
function txDb(exec: Exec): Db {
  let depth = 0;
  const self: Db = makeDb(exec, async (fn) => {
    const sp = `sp_${++depth}`;
    await exec(`SAVEPOINT ${sp}`, []);
    try {
      const out = await fn(self);
      await exec(`RELEASE SAVEPOINT ${sp}`, []);
      return out;
    } catch (e) {
      await exec(`ROLLBACK TO SAVEPOINT ${sp}`, []);
      throw e;
    } finally {
      depth--;
    }
  });
  return self;
}

export function pgDb(pool: Pick<Pool, "query" | "connect">): Db {
  const exec: Exec = async (sql, params) => {
    const r = await pool.query(toPgPlaceholders(sql), params as any[]);
    return { rows: r.rows, rowCount: r.rowCount ?? 0 };
  };
  return makeDb(exec, async (fn) => {
    const client: PoolClient = await pool.connect();
    const clientExec: Exec = async (sql, params) => {
      const r = await client.query(toPgPlaceholders(sql), params as any[]);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    };
    try {
      await client.query("BEGIN");
      const out = await fn(txDb(clientExec));
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  });
}

const MAX_PARAMS = 30000;   // Postgres allows 65535 bind parameters per statement; stay well below

/**
 * Multi-row INSERT in as few statements as the parameter limit allows (a round trip per row is what makes
 * serverless + a remote database slow). `suffix` is appended verbatim, e.g. "ON CONFLICT DO NOTHING".
 * Returns the number of rows inserted.
 */
export async function insertMany(db: Db, table: string, columns: string[], rows: unknown[][], suffix = ""): Promise<number> {
  if (rows.length === 0) return 0;
  const perStatement = Math.max(1, Math.floor(MAX_PARAMS / columns.length));
  const one = `(${columns.map(() => "?").join(", ")})`;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += perStatement) {
    const chunk = rows.slice(i, i + perStatement);
    inserted += await db.run(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${chunk.map(() => one).join(", ")} ${suffix}`.trim(),
      chunk.flat());
  }
  return inserted;
}

/** Wraps an already-open transaction/executor (PGlite) in the same Db surface. */
export { txDb as transactionDb };

export function appPoolFromEnv(env: NodeJS.ProcessEnv = process.env): Pool {
  const url = env.APP_DB_URL ?? env.SUPABASE_DB_URL;
  if (!url) throw new Error("APP_DB_URL is not set (Supabase Postgres connection string, transaction pooler :6543 on Netlify)");
  return new Pool({
    connectionString: url,
    // One serverless instance serves one request at a time; a long-lived dev server wants a few.
    max: Number(env.APP_DB_POOL_MAX ?? (env.NETLIFY ? 1 : 3)),
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10_000,
    statement_timeout: 20_000,
    types: { getTypeParser: (oid: number, format?: any) => valueParsers[oid] ?? pgTypes.getTypeParser(oid, format) } as any,
    // Supabase's pooler certificate is not in the default trust store; plain sslmode=require would be verified.
    ...(env.APP_DB_SSL === "no-verify" ? { ssl: { rejectUnauthorized: false } } : {}),
  });
}
