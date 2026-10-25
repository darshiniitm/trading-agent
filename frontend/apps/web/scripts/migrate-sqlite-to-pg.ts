// One-off: copy the old SQLite app database into Postgres (screener_app), keeping every numeric id.
//   APP_DB_URL=postgresql://... npx tsx scripts/migrate-sqlite-to-pg.ts [path/to/app.db]
// Refuses a target that already holds app data; all-or-nothing. Needs better-sqlite3 (a dev dependency, never bundled).
import Database from "better-sqlite3";
import path from "node:path";
import { closeDb, db } from "../src/server/db/client";
import { moveSqliteToPostgres } from "../src/server/db/sqliteMove";

async function main() {
  const file = path.resolve(process.argv[2] ?? path.join(process.cwd(), "data", "app.db"));
  console.log(`Reading ${file}`);
  const sqlite = new Database(file, { readonly: true, fileMustExist: true });
  const { rows } = await moveSqliteToPostgres(sqlite, db());
  for (const [table, n] of Object.entries(rows)) console.log(`  ${table.padEnd(26)} ${n}`);
  console.log("Done. Row counts in Postgres match the SQLite source.");
  await closeDb();
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
