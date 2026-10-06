type TraceableOutput = {
  conditions: { value?: unknown; params?: Record<string, unknown> }[];
  risk_cap_pct?: number | null;
  near_miss?: { max_failed?: number } | null;
  selection_point?: { session_of_week?: number; at?: string } | null;
  t1_window?: { length_sessions?: number; offsets?: number[] } | null;
};

function isPresent(v: unknown): boolean {
  return v !== null && v !== undefined;
}

// Every parameter VALUE the prompt (or the user's answer) has to account for,
// by its canonical dotted path — numbers AND strings alike (D6: "every
// parameter comes from the user's prompt or their answer"; a fabricated
// params.source: "high" or selection_point.at: "open" is as much an invented
// value as a fabricated 14).
//
// Deliberately NOT walked — structural, compiler-decided fields that are
// never prompt-supplied data: a condition's id, role, kind, name, op and dir,
// and stop.from (a reference to a condition id, not a traced value). The
// structure choice is not a parameter value either.
export function traceableLeafPaths(output: TraceableOutput): string[] {
  const paths: string[] = [];

  output.conditions.forEach((c, i) => {
    if (Array.isArray(c.value)) {
      c.value.forEach((v, j) => { if (isPresent(v)) paths.push(`conditions.${i}.value.${j}`); });
    } else if (isPresent(c.value)) {
      paths.push(`conditions.${i}.value`);
    }
    for (const [key, v] of Object.entries(c.params ?? {})) {
      if (isPresent(v)) paths.push(`conditions.${i}.params.${key}`);
    }
  });

  if (isPresent(output.risk_cap_pct)) paths.push("risk_cap_pct");
  if (output.near_miss && isPresent(output.near_miss.max_failed)) paths.push("near_miss.max_failed");
  if (output.selection_point) {
    if (isPresent(output.selection_point.session_of_week)) paths.push("selection_point.session_of_week");
    if (isPresent(output.selection_point.at)) paths.push("selection_point.at");
  }
  if (output.t1_window) {
    if (isPresent(output.t1_window.length_sessions)) paths.push("t1_window.length_sessions");
    (output.t1_window.offsets ?? []).forEach((v, j) => { if (isPresent(v)) paths.push(`t1_window.offsets.${j}`); });
  }

  return paths;
}

export class UntraceableValueError extends Error {
  paths: string[];
  constructor(paths: string[]) {
    super(`values at these paths have no source phrase and no recorded user answer: ${paths.join(", ")}`);
    this.paths = paths;
  }
}

export function assertTraceable(
  output: TraceableOutput,
  sourcePhrases: { path: string }[],
  answeredPaths: string[] = []
): void {
  const known = new Set([...sourcePhrases.map((s) => s.path), ...answeredPaths]);
  const missing = traceableLeafPaths(output).filter((p) => !known.has(p));
  if (missing.length > 0) throw new UntraceableValueError(missing);
}
