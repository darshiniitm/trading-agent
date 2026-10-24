import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { makeDb, transactionDb, valueParsers, toPgPlaceholders, type Db } from "./pg";

// Test-only: an in-process Postgres (PGlite) with the real warehouse migrations applied, so tests run
// the same db/migrations/*.sql that Supabase runs. Never imported by app code.
const MIGRATIONS_DIR = path.join(process.cwd(), "..", "..", "..", "db", "migrations");

let template: Promise<Blob> | undefined;

function options() {
  return { extensions: { citext }, parsers: valueParsers as any };
}

async function buildTemplate(): Promise<Blob> {
  const pg = new PGlite(options());
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  for (const file of files) await pg.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8"));
  const dump = (await pg.dumpDataDir("none")) as Blob;
  await pg.close();
  return dump;
}

export function pgliteDb(pg: PGlite): Db {
  const exec = async (sql: string, params: unknown[]) => {
    const r = await pg.query(toPgPlaceholders(sql), params as any[]);
    return { rows: r.rows as any[], rowCount: r.affectedRows ?? r.rows.length };
  };
  return makeDb(exec, async (fn) => {
    await exec("BEGIN", []);
    try {
      const out = await fn(transactionDb(exec));
      await exec("COMMIT", []);
      return out;
    } catch (e) {
      await exec("ROLLBACK", []);
      throw e;
    }
  });
}

/** A fresh, empty app database (migrations applied, no rows). Each call is independent. */
export async function createTestDb(): Promise<Db> {
  template ??= buildTemplate();
  const pg = new PGlite({ ...options(), loadDataDir: await template });
  await pg.exec("SET search_path = screener_app, public");
  return pgliteDb(pg);
}
