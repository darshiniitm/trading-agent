import { isWarmingBody } from "@/lib/engineStatus";

// The API surface a page's fetch() can see is a mix of four shapes:
// - this app's own routes: {"error": "<message>"}
// - the engine's 422 passed through verbatim: {"detail": [{"condition_id", "message"}, ...]}
// - the engine's own 500, passed through as EngineError.body: a bare string
// - the compile route's CompileError 422: {"errors": ["<message>", ...]}
// describeApiError normalizes all four into one readable line.
export function describeApiError(body: unknown, fallback: string): string {
  if (typeof body === "string") return body;
  // the engine is still loading its data (503): never shown as a failure, the app has a loading state for it
  if (isWarmingBody(body)) return "The data engine is still loading market data. Your run will start as soon as it is ready.";
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    if (typeof obj.error === "string") return obj.error;
    if (typeof obj.detail === "string") return obj.detail;   // the engine's /data/upload 422 and /validate 422
    if (Array.isArray(obj.detail)) {
      return obj.detail
        .map((d: any) => (d?.condition_id ? `${d.condition_id}: ${d.message}` : String(d?.message ?? d)))
        .join("; ");
    }
    if (Array.isArray(obj.errors) && obj.errors.every((e) => typeof e === "string")) {
      return (obj.errors as string[]).join("; ");
    }
  }
  return fallback;
}

// The compile route's 422 carries the raw validation errors for logs/tests, but
// the user is shown a plain line: how many parts were unreadable, not zod paths.
export function friendlyCompileError(errors: string[]): string {
  const n = new Set(errors.map((e) => e.split(":")[0].replace(/\.\d+(?=\.|$)/g, ""))).size || errors.length;
  return `Couldn't read ${n} part${n === 1 ? "" : "s"} of your prompt. Try rephrasing it, stating each value (like "RSI 50 to 65") in the same line as its indicator — or use "Interpret my prompt" below, which reads multi-step prompts line by line.`;
}
