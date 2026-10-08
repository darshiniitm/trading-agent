import { createHmac, timingSafeEqual } from "node:crypto";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error("SESSION_SECRET is not set in .env.local");
  return value;
}

function signature(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function createSessionCookie(userId: number, now: () => number = Date.now): string {
  const payload = `${userId}.${now() + SESSION_TTL_MS}`;
  return `${payload}.${signature(payload)}`;
}

export function verifySessionCookie(cookie: string | null | undefined, now: () => number = Date.now): number | null {
  if (!cookie) return null;
  const parts = cookie.split(".");
  if (parts.length !== 3) return null;
  const [userIdText, expiresText, actual] = parts;
  let expected: string;
  try { expected = signature(`${userIdText}.${expiresText}`); } catch { return null; }
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  const userId = Number(userIdText);
  const expires = Number(expiresText);
  if (!Number.isInteger(userId) || userId <= 0 || !Number.isFinite(expires) || now() > expires) return null;
  return userId;
}

export const SESSION_COOKIE = "prompt_screener_session";
