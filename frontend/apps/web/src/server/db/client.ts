import type { Pool } from "pg";
import { appPoolFromEnv, pgDb, type Db } from "./pg";

export type { Db } from "./pg";

// One pool per server process / function instance, kept on globalThis so Next's module reloads in dev (and
// separate route bundles in production) share it instead of each opening their own connections.
const g = globalThis as unknown as { __appPool?: Pool; __appDb?: Db };

/** The app database (Supabase Postgres, schema screener_app). Lazy: nothing connects until the first query. */
export function db(): Db {
  if (!g.__appDb) {
    g.__appPool = appPoolFromEnv();
    g.__appDb = pgDb(g.__appPool);
  }
  return g.__appDb;
}

export async function closeDb(): Promise<void> {
  const pool = g.__appPool;
  g.__appPool = undefined;
  g.__appDb = undefined;
  await pool?.end();
}
