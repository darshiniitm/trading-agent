// Step 7 — verify. Schema, id references, path grammar, and span-checked traceability: a source
// phrase only proves a value if its span exists in the normalised prompt and the value can be
// re-read from that very span (or the user answered it).
import { ScreenProgramSchema, type ScreenProgram } from "spec";
import { valueTracesToPhrase } from "../spanCheck";

const NAME = "[a-z][a-z0-9_]*";
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);
export const PATH_RE = [
  /^universe\.(source|index)$/,
  new RegExp(`^conditions\\.C\\d+\\.(op|tf|rhs|rhs_mult|within_bars|bars|value(\\.\\d+)?|params\\.${NAME}|rhs\\.params\\.${NAME})$`),
  /^actions\.A\d+\.(set|entry\.at|confidence\.method|confidence\.n_weeks|highlight\.metric|highlight\.lookback_weeks|highlight\.rule\.(rs_gt|top_k|gt)|stop\.from|shift\.weeks|horizons_w|by|n)$/,
];

export function pathProblem(path: string): string | null {
  const parts = path.split(".");
  if (parts.some((p) => FORBIDDEN.has(p))) return "forbidden path segment";
  if (!PATH_RE.some((re) => re.test(path))) return "not one of the allowed paths";
  const idx = /\.value\.(\d+)$/.exec(path);
  if (idx && Number(idx[1]) > 1) return "value index out of range";
  return null;
}

export class ProgramVerifyError extends Error {
  problems: string[];
  constructor(problems: string[]) { super(`program failed verification: ${problems.join("; ")}`); this.problems = problems; }
}

function getAt(root: any, path: string[]): unknown {
  return path.reduce((o, k) => (o == null ? undefined : o[k]), root);
}

export function tracedLeafPaths(p: ScreenProgram): { path: string; value: unknown }[] {
  const out: { path: string; value: unknown }[] = [];
  const nn = (v: unknown) => v !== null && v !== undefined;
  for (const c of p.conditions) {
    if (Array.isArray(c.value)) c.value.forEach((v, i) => nn(v) && out.push({ path: `conditions.${c.id}.value.${i}`, value: v }));
    else if (nn(c.value)) out.push({ path: `conditions.${c.id}.value`, value: c.value });
    for (const [k, v] of Object.entries((c.lhs as any).params ?? {})) nn(v) && out.push({ path: `conditions.${c.id}.params.${k}`, value: v });
    for (const [k, v] of Object.entries((c.rhs as any)?.params ?? {})) nn(v) && out.push({ path: `conditions.${c.id}.rhs.params.${k}`, value: v });
    if (nn(c.bars)) out.push({ path: `conditions.${c.id}.bars`, value: c.bars });
  }
  if (p.universe.index) out.push({ path: "universe.index", value: p.universe.index });
  return out;
}

export function verifyProgram(program: unknown, norm: string): ScreenProgram {
  const parsed = ScreenProgramSchema.safeParse(program);
  if (!parsed.success) throw new ProgramVerifyError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const p = parsed.data;
  const problems: string[] = [];

  const condIds = new Set(p.conditions.map((c) => c.id)), setIds = new Set(p.sets.map((s) => s.id));
  if (condIds.size !== p.conditions.length || setIds.size !== p.sets.length) problems.push("condition/set ids must be unique");
  const leavesOf = (n: any): string[] => typeof n === "string" ? [n] : n?.all ? n.all.flatMap(leavesOf) : n?.any ? n.any.flatMap(leavesOf) : n?.not ? [n.not].flat().flatMap(leavesOf) : [];
  for (const s of p.sets) {
    if (s.from !== "universe" && !setIds.has(s.from)) problems.push(`set ${s.id} is from unknown set ${s.from}`);
    for (const l of leavesOf(s.where)) if (!condIds.has(l)) problems.push(`set ${s.id} references unknown condition ${l}`);
  }
  for (const a of p.actions) if ("set" in a && a.set && !setIds.has(a.set as string)) problems.push(`action ${a.id} uses unknown set ${a.set}`);

  for (const n of p.needs_input) { const pr = pathProblem(n.path); if (pr) problems.push(`needs_input ${n.path}: ${pr}`); }
  for (const s of p.source_phrases) {
    const pr = pathProblem(s.path); if (pr) problems.push(`source_phrases ${s.path}: ${pr}`);
    if (norm.slice(s.span[0], s.span[1]) !== s.phrase) problems.push(`${s.path}: span does not contain the phrase ${JSON.stringify(s.phrase)} in the prompt`);
  }

  const byPath = new Map(p.source_phrases.map((s) => [s.path, s.phrase]));
  // a value the phrase only implies is listed as an assumption (with its reason) instead of being traced to words
  const answered = new Set([...p.answers.map((a) => a.path), ...(p.assumptions ?? []).map((a) => a.path)]);
  for (const { path, value } of tracedLeafPaths(p)) {
    if (answered.has(path)) continue;
    const phrase = byPath.get(path);
    if (phrase === undefined) problems.push(`${path}: no source phrase and no user answer — never invent a value`);
    else if (!valueTracesToPhrase(value, phrase)) problems.push(`${path}: value ${JSON.stringify(value)} cannot be read from its source phrase ${JSON.stringify(phrase)}`);
  }
  void getAt;
  if (problems.length) throw new ProgramVerifyError(problems);
  return p;
}
