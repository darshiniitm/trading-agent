import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { insertMany, makeDb, transactionDb, valueParsers, toPgPlaceholders, type Db } from "./pg";

// Test-only: an in-process Postgres (PGlite) with the real warehouse migrations applied, so tests run
// the same db/migrations/*.sql that Supabase runs. Never imported by app code.
const MIGRATIONS_DIR = path.join(process.cwd(), "..", "..", "..", "db", "migrations");

function options() {
  return { extensions: { citext }, parsers: valueParsers as any };
}

const migrationFiles = () => fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();

// Building the template (applying every migration in WASM Postgres) takes seconds, so it is done once per
// migration set and cached on disk; each test then loads a copy in a few hundred milliseconds.
function templatePath(): string {
  const hash = createHash("sha1");
  for (const f of migrationFiles()) hash.update(f).update(fs.readFileSync(path.join(MIGRATIONS_DIR, f)));
  return path.join(process.cwd(), "node_modules", ".cache", "pglite-template", `${hash.digest("hex").slice(0, 16)}.tar`);
}

let template: Promise<Blob> | undefined;

/** Builds the cached template if it is missing; vitest's globalSetup calls this once before the workers start. */
export async function ensureTemplate(): Promise<Blob> {
  const file = templatePath();
  if (fs.existsSync(file)) return new Blob([fs.readFileSync(file)]);
  const pg = new PGlite(options());
  for (const f of migrationFiles()) await pg.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf-8"));
  const dump = (await pg.dumpDataDir("none")) as Blob;
  await pg.close();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, Buffer.from(await dump.arrayBuffer()));
  fs.renameSync(tmp, file);   // atomic: a worker never reads a half-written template
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

// One WASM Postgres per test file (loading the data directory costs ~1s); between tests it is emptied instead.
let shared: { pg: PGlite; db: Db; seedSymbols: Record<string, unknown>[] } | undefined;

async function reset(s: NonNullable<typeof shared>) {
  const tables = await s.pg.query<{ t: string }>("SELECT quote_ident(table_name) AS t FROM information_schema.tables WHERE table_schema = 'screener_app' AND table_type = 'BASE TABLE'");
  await s.pg.exec(`TRUNCATE ${tables.rows.map((r) => `screener_app.${r.t}`).join(", ")} RESTART IDENTITY CASCADE`);
  await insertMany(s.db, "symbols", Object.keys(s.seedSymbols[0]), s.seedSymbols.map((r) => Object.values(r)));
}

/** An empty app database (migrations applied, only the migration's own seed rows). Each call starts clean. */
export async function createTestDb(): Promise<Db> {
  if (shared) { await reset(shared); return shared.db; }
  template ??= ensureTemplate();
  const pg = new PGlite({ ...options(), loadDataDir: await template });
  await pg.exec("SET search_path = screener_app, public");
  const db = pgliteDb(pg);
  shared = { pg, db, seedSymbols: await db.all("SELECT * FROM symbols ORDER BY symbol") };
  return db;
}

/** Called from vitest.setup.ts after each file: an open WASM Postgres would keep the worker (and the run) alive. */
export async function closeTestDb(): Promise<void> {
  const s = shared;
  shared = undefined;
  await s?.pg.close();
}
