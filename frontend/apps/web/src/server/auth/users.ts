import type Database from "better-sqlite3";
import argon2 from "argon2";

export async function createUser(raw: Database.Database, input: { displayName: string; email: string; password: string }) {
  const displayName = input.displayName.trim();
  const email = input.email.trim().toLowerCase();
  if (!displayName || !email || input.password.length < 8) throw new Error("name, email, and a password of at least 8 characters are required");
  const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
  try {
    const result = raw.prepare("INSERT INTO users (display_name, email, password_hash, role, status, created_at) VALUES (?, ?, ?, 'member', 'active', ?)").run(displayName, email, passwordHash, new Date().toISOString());
    return { userId: Number(result.lastInsertRowid) };
  } catch (error: any) {
    if (String(error.message).includes("UNIQUE constraint failed: users.email")) throw new Error("email is already registered");
    throw error;
  }
}

export async function verifyPassword(raw: Database.Database, input: { email: string; password: string }) {
  const row = raw.prepare("SELECT user_id, password_hash, status FROM users WHERE email = ? COLLATE NOCASE").get(input.email.trim().toLowerCase()) as { user_id: number; password_hash: string | null; status: string } | undefined;
  if (!row || row.status !== "active" || !row.password_hash) return null;
  try {
    return await argon2.verify(row.password_hash, input.password) ? { userId: row.user_id } : null;
  } catch { return null; }
}
