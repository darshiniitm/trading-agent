import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { ensureOwnerUser } from "./seed";
import { applyMigrations } from "./migrate";

const DB_PATH = path.join(process.cwd(), "data", "app.db");

let instance: Database.Database | null = null;

export function db(): Database.Database {
  if (instance) return instance;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const raw = new Database(DB_PATH);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  applyMigrations(raw);
  ensureOwnerUser(raw);
  instance = raw;
  return instance;
}
