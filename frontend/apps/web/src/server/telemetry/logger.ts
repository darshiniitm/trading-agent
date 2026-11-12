// One structured JSON line to stdout (when enabled) and the same record as an OTel LogRecord (→ Alloy → Loki).
// The LogRecord is emitted with the span's context so Loki lines carry trace_id/span_id.
import { SeverityNumber } from "@opentelemetry/api-logs";
import type { Context } from "@opentelemetry/api";
import { runtime } from "./runtime";

export function emitLog(level: "INFO" | "ERROR" | "WARN", body: string, fields: Record<string, unknown>, ctx?: Context): void {
  const rt = runtime();
  try {
    if (rt.stdoutLogs) console.log(JSON.stringify({ level, msg: body, ...fields }));
    rt.logger?.emit({
      severityNumber: level === "ERROR" ? SeverityNumber.ERROR : level === "WARN" ? SeverityNumber.WARN : SeverityNumber.INFO,
      severityText: level,
      body,
      attributes: flatten(fields),
      ...(ctx ? { context: ctx } : {}),
    });
  } catch { /* logging must never fail a run */ }
}

// OTel attribute values must be primitives: nested input/output become JSON strings.
function flatten(fields: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : JSON.stringify(v);
  }
  return out;
}
