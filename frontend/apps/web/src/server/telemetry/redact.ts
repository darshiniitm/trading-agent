// Redaction applied to everything that leaves the process (spans, logs, Postgres rows). Mirrors src/telemetry/redact.py;
// both are tested against observability/redaction-fixtures.json. User ids are HMAC-hashed, never stored raw.
import { createHmac } from "node:crypto";

export const MAX_FIELD_CHARS = 16 * 1024;
// `token(?!s)`: a token COUNT (input_tokens, tokens) is telemetry, a `token` is a credential.
const SECRET_KEY = /(authorization|api[-_]?key|password|passwd|secret|cookie|token(?!s))/i;

export function redactString(s: string): string {
  return s
    .replace(/(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s]+(@)/gi, "$1[redacted]$2")
    .replace(/(Bearer\s+)[^\s"',;]+/gi, "$1[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]");
}

export function redactValue(v: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof v === "string") return redactString(v);
  if (v === null || typeof v !== "object") return v;
  if (seen.has(v)) return "[circular]";
  seen.add(v);
  if (Array.isArray(v)) return v.map((x) => redactValue(x, seen));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) out[k] = SECRET_KEY.test(k) ? "[redacted]" : redactValue(val, seen);
  return out;
}

export function hashUser(id: string, salt: string): string {
  return createHmac("sha256", salt).update(String(id)).digest("hex").slice(0, 16);
}

export function truncate(s: string, max: number = MAX_FIELD_CHARS): { text: string; truncated: boolean } {
  return s.length > max ? { text: s.slice(0, max), truncated: true } : { text: s, truncated: false };
}
