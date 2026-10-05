import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const MIGRATION_PATH = path.join(__dirname, "migrations", "0001_init.sql");

export function createTestDb(): Database.Database {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  const sql = fs.readFileSync(MIGRATION_PATH, "utf-8");
  raw.exec(sql);
  return raw;
}
