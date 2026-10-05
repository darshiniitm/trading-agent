import type Database from "better-sqlite3";

export function ensureOwnerUser(raw: Database.Database): number {
  const existing = raw.prepare("SELECT user_id FROM users ORDER BY user_id LIMIT 1").get() as
    | { user_id: number }
    | undefined;
  if (existing) return existing.user_id;
  const now = new Date().toISOString();
  const info = raw
    .prepare("INSERT INTO users (display_name, role, status, created_at) VALUES ('Owner', 'owner', 'active', ?)")
    .run(now);
  return Number(info.lastInsertRowid);
}
