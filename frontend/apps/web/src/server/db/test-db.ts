import Database from "better-sqlite3";
import { applyMigrations } from "./migrate";

export function createTestDb(): Database.Database {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  applyMigrations(raw);
  return raw;
}
