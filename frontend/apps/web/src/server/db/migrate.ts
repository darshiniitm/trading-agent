import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

// __dirname is unreliable here: Next.js's dev/production server bundles this
// module into .next/server/..., where __dirname no longer points at the real
// source tree. process.cwd() is apps/web in every way this app is run (next dev/start, and
// vitest), so anchor to the source path from there instead.
const MIGRATIONS_DIR = path.join(process.cwd(), "src", "server", "db", "migrations");

export function applyMigrations(raw: Database.Database): void {
  raw.exec(`CREATE TABLE IF NOT EXISTS _migrations (filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set(
    (raw.prepare("SELECT filename FROM _migrations").all() as { filename: string }[]).map((r) => r.filename)
  );

  // Backward-compatibility: if 0001_init.sql was already executed by the old
  // client.ts (which didn't track migrations), mark it as applied now.
  // Check if users table exists but 0001_init.sql is not yet recorded.
  if (!applied.has("0001_init.sql")) {
    const usersTableExists = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'")
      .get();
    if (usersTableExists) {
      raw.prepare("INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)").run("0001_init.sql", new Date().toISOString());
      applied.add("0001_init.sql");
    }
  }

  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
    raw.exec(sql);
    raw.prepare("INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)").run(file, new Date().toISOString());
  }
}
