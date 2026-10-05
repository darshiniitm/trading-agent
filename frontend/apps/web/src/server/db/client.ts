import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { ensureOwnerUser } from "./seed";

const MIGRATION_PATH = path.join(__dirname, "migrations", "0001_init.sql");
const DB_PATH = path.join(process.cwd(), "data", "app.db");

let instance: Database.Database | null = null;

export function db(): Database.Database {
  if (instance) return instance;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const raw = new Database(DB_PATH);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  const alreadyInitialized = raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'")
    .get();
  if (!alreadyInitialized) {
    raw.exec(fs.readFileSync(MIGRATION_PATH, "utf-8"));
  }
  ensureOwnerUser(raw);
  instance = raw;
  return instance;
}
