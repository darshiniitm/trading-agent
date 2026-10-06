// The API surface a page's fetch() can see is a mix of four shapes:
// - this app's own routes: {"error": "<message>"}
// - the engine's 422 passed through verbatim: {"detail": [{"condition_id", "message"}, ...]}
// - the engine's own 500, passed through as EngineError.body: a bare string
// - the compile route's CompileError 422: {"errors": ["<message>", ...]}
// describeApiError normalizes all four into one readable line.
export function describeApiError(body: unknown, fallback: string): string {
  if (typeof body === "string") return body;
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    if (typeof obj.error === "string") return obj.error;
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
