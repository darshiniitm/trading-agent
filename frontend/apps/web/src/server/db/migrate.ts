import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

// Same reasoning as client.ts's existing MIGRATION_PATH comment: __dirname
// doesn't survive Next.js's server bundling, so anchor to process.cwd()
// (apps/web, under next dev/start and under vitest alike).
const MIGRATIONS_DIR = path.join(process.cwd(), "src", "server", "db", "migrations");

export function applyMigrations(raw: Database.Database): void {
  raw.exec(`CREATE TABLE IF NOT EXISTS _migrations (filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set(
    (raw.prepare("SELECT filename FROM _migrations").all() as { filename: string }[]).map((r) => r.filename)
  );
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
    raw.exec(sql);
    raw.prepare("INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)").run(file, new Date().toISOString());
  }
}
