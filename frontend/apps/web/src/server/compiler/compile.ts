import { CompileOutputSchema, type CompileOutput } from "spec";
import { buildCompilerPrompt, buildRetryUser } from "@/server/compiler/promptBuilder";
import { assertTraceable, UntraceableValueError } from "@/server/compiler/traceability";
import { callClaude } from "@/server/compiler/callModel";

export class CompileError extends Error {
  errors: string[];
  constructor(errors: string[]) {
    super(`compile failed after retrying once: ${errors.join("; ")}`);
    this.errors = errors;
  }
}

type CatalogEntry = { kind: string; name: string; required_params?: { name: string }[] };

function validateAgainstCatalog(output: CompileOutput, catalog: CatalogEntry[]): string[] {
  const errors: string[] = [];
  const byKey = new Map(catalog.map((c) => [`${c.kind}:${c.name}`, c]));

  output.conditions.forEach((cond, i) => {
    const entry = byKey.get(`${cond.kind}:${cond.name}`);
    if (!entry) {
      errors.push(`conditions.${i}: "${cond.kind}:${cond.name}" is not in the catalog — it must go into "unsupported" instead`);
      return;
    }
    for (const p of entry.required_params ?? []) {
      const present = (cond.params ?? {})[p.name] !== undefined;
      const flagged = output.needs_input.some((n) => n.path === `conditions.${i}.params.${p.name}`);
      if (!present && !flagged) errors.push(`conditions.${i}.params.${p.name}: required by the catalog, but neither present nor flagged in needs_input`);
    }
  });

  if (output.needs_input.some((n) => /liquidity/i.test(n.question))) {
    errors.push('needs_input must never ask about liquidity — the app always asks that separately, remove that item');
  }

  return errors;
}

// needs_input/source_phrases paths come straight from the model's output and
// later drive mergeAnswer.ts's dynamic setAtPath() write, so they are
// untrusted input: anything outside this explicit grammar is a validation
// error (forcing the usual single retry), never passed through. This is
// layer 1 of the prototype-pollution defense; setAtPath() refuses
// __proto__/constructor/prototype segments on its own as layer 2.
const FIXED_PATHS = new Set([
  "structure", "risk_cap_pct", "selection_point.session_of_week", "selection_point.at",
  "near_miss.max_failed", "t1_window.length_sessions",
]);
const INDEX = "(0|[1-9][0-9]*)"; // non-negative integer, no leading zeros
const IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
// The identifier pattern alone does NOT exclude these (each is a valid
// identifier), so they are refused explicitly.
const FORBIDDEN_NAMES = new Set(["__proto__", "constructor", "prototype"]);
// Bound on the second-level indexes (a condition's value band, the T1
// window's offsets) — generous for any real spec, small enough that a
// fabricated index can't blow up the spec when an answer is written to it.
export const MAX_SECONDARY_INDEX = 64;

export function pathGrammarError(path: string, conditionCount: number): string | null {
  if (FIXED_PATHS.has(path)) return null;
  let m = new RegExp(`^t1_window\\.offsets\\.${INDEX}$`).exec(path);
  if (m) return Number(m[1]) < MAX_SECONDARY_INDEX ? null : `offset index ${m[1]} is out of range`;
  m = new RegExp(`^conditions\\.${INDEX}\\.(params\\.([^.]+)|value(\\.${INDEX})?)$`).exec(path);
  if (!m) return "not one of the allowed paths";
  if (Number(m[1]) >= conditionCount) return `condition index ${m[1]} does not exist (there are ${conditionCount} condition(s))`;
  const param = m[3];
  if (param !== undefined && (!IDENTIFIER.test(param) || FORBIDDEN_NAMES.has(param))) return `"${param}" is not a valid parameter name`;
  const valueIndex = m[5];
  if (valueIndex !== undefined && Number(valueIndex) >= MAX_SECONDARY_INDEX) return `value index ${valueIndex} is out of range`;
  return null;
}

export function validatePaths(output: CompileOutput): string[] {
  const errors: string[] = [];
  const check = (kind: "needs_input" | "source_phrases", path: string) => {
    const problem = pathGrammarError(path, output.conditions.length);
    if (problem) {
      errors.push(
        `${kind} path ${JSON.stringify(path)}: ${problem} — use only structure, risk_cap_pct, selection_point.session_of_week, selection_point.at, near_miss.max_failed, t1_window.length_sessions, t1_window.offsets.<N>, conditions.<N>.params.<name>, conditions.<N>.value, conditions.<N>.value.<N>`
      );
    }
  };
  output.needs_input.forEach((n) => check("needs_input", n.path));
  output.source_phrases.forEach((s) => check("source_phrases", s.path));
  return errors;
}

type CallModelFn = (system: string, user: string) => Promise<string>;

export async function compilePrompt(
  promptText: string,
  catalog: CatalogEntry[],
  structures: unknown[],
  { callModel = callClaude }: { callModel?: CallModelFn } = {}
): Promise<{ output: CompileOutput; raw: string; attempts: number }> {
  const { system, user } = buildCompilerPrompt(promptText, catalog, structures);
  let lastErrors: string[] = [];
  let lastRaw = "";

  for (let attempt = 1; attempt <= 2; attempt++) {
    const userForThisAttempt = attempt === 1 ? user : buildRetryUser(user, lastErrors);
    lastRaw = await callModel(system, userForThisAttempt);

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(lastRaw);
    } catch {
      lastErrors = ["response was not valid JSON"];
      continue;
    }

    const parsed = CompileOutputSchema.safeParse(parsedJson);
    if (!parsed.success) {
      lastErrors = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
      continue;
    }

    const catalogErrors = [...validatePaths(parsed.data), ...validateAgainstCatalog(parsed.data, catalog)];
    if (catalogErrors.length > 0) {
      lastErrors = catalogErrors;
      continue;
    }

    try {
      assertTraceable(parsed.data, parsed.data.source_phrases);
    } catch (err) {
      if (err instanceof UntraceableValueError) {
        lastErrors = err.paths.map((p) => `${p}: no source phrase for this number — never invent a value, add it to source_phrases or drop it`);
        continue;
      }
      throw err;
    }

    return { output: parsed.data, raw: lastRaw, attempts: attempt };
  }

  throw new CompileError(lastErrors);
}
