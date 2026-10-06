type TraceableOutput = {
  conditions: { value?: unknown; params?: Record<string, unknown> }[];
  risk_cap_pct?: number | null;
  near_miss?: { max_failed: number } | null;
  selection_point?: { session_of_week: number } | null;
  t1_window?: { length_sessions: number; offsets: number[] } | null;
};

export function numericLeafPaths(output: TraceableOutput): string[] {
  const paths: string[] = [];

  output.conditions.forEach((c, i) => {
    if (typeof c.value === "number") paths.push(`conditions.${i}.value`);
    if (Array.isArray(c.value)) {
      c.value.forEach((v, j) => { if (typeof v === "number") paths.push(`conditions.${i}.value.${j}`); });
    }
    for (const [key, v] of Object.entries(c.params ?? {})) {
      if (typeof v === "number") paths.push(`conditions.${i}.params.${key}`);
    }
  });

  if (typeof output.risk_cap_pct === "number") paths.push("risk_cap_pct");
  if (output.near_miss && typeof output.near_miss.max_failed === "number") paths.push("near_miss.max_failed");
  if (output.selection_point && typeof output.selection_point.session_of_week === "number") paths.push("selection_point.session_of_week");
  if (output.t1_window) {
    if (typeof output.t1_window.length_sessions === "number") paths.push("t1_window.length_sessions");
    output.t1_window.offsets.forEach((v, j) => { if (typeof v === "number") paths.push(`t1_window.offsets.${j}`); });
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
  const missing = numericLeafPaths(output).filter((p) => !known.has(p));
  if (missing.length > 0) throw new UntraceableValueError(missing);
}
