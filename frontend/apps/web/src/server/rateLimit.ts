// In-memory sliding window per (bucket, user). Per-process only: enough for one server; swap for a shared store if scaled out.
const hits = new Map<string, number[]>();

export const LIMITS = { data: { max: 120, windowMs: 60_000 }, model: { max: 12, windowMs: 60_000 } } as const;
export type Bucket = keyof typeof LIMITS;

/** Returns a 429 Response when the user is over the bucket's limit, else null (and counts the call). */
export function rateLimited(userId: number, bucket: Bucket, now = Date.now()): Response | null {
  const { max, windowMs } = LIMITS[bucket];
  const key = `${bucket}:${userId}`;
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    hits.set(key, recent);
    const retry = Math.ceil((recent[0] + windowMs - now) / 1000);
    return Response.json({ error: "Too many requests. Please wait a moment and try again." }, { status: 429, headers: { "retry-after": String(retry) } });
  }
  recent.push(now); hits.set(key, recent);
  return null;
}
export function resetRateLimits() { hits.clear(); }
