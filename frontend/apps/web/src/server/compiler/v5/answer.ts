// Applying a user's answer to a draft program: path-scoped (id-keyed, so adding or removing a
// condition never shifts an answer onto the wrong value), type-checked against the registry, and
// followed by any follow-up questions the answer itself raises (a chosen metric needs its rule).
import type { NeedsInputV5, ScreenProgram } from "spec";
import { pathProblem } from "./verify";
import { INDICATORS } from "./registry";
import { CONFIDENCE_OPTIONS, ENTRY_OPTIONS, METRIC_OPTIONS } from "./questions";

export class AnswerError extends Error {}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const enumVals = (o: { value: unknown }[]) => o.map((x) => x.value);

function numberOf(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw new AnswerError("that value must be a number");
  return n;
}

export function applyProgramAnswer(program: ScreenProgram, path: string, value: unknown): ScreenProgram {
  const problem = pathProblem(path);
  if (problem) throw new AnswerError(`path ${JSON.stringify(path)}: ${problem}`);
  const item = program.needs_input.find((n) => n.path === path);
  if (!item) throw new AnswerError(`there is no open question at ${path}`);
  const p = clone(program);
  const set = (fn: () => void) => { fn(); };

  let m: RegExpExecArray | null;
  if ((m = /^conditions\.(C\d+)\.(.+)$/.exec(path))) {
    const c = p.conditions.find((x) => x.id === m![1])!;
    const rest = m[2];
    let pm: RegExpExecArray | null;
    if (rest === "op") {
      const opt = item.options?.find((o) => JSON.stringify(o.value) === JSON.stringify(value));
      if (!opt) throw new AnswerError("choose one of the offered options");
      const v = opt.value as { op: string; value: unknown };
      set(() => { c.op = v.op; c.value = v.value; });
      // the chosen numbers are the user's own words, traced through their answer
      if (Array.isArray(v.value)) { p.answers.push({ path: `conditions.${c.id}.value.0` }, { path: `conditions.${c.id}.value.1` }); }
      else p.answers.push({ path: `conditions.${c.id}.value` });
    } else if (rest === "tf") {
      if (!["1D", "1W", "1M"].includes(value as string)) throw new AnswerError("timeframe must be daily, weekly or monthly");
      set(() => { (c.lhs as any).tf = value; if (c.rhs) (c.rhs as any).tf = value; });
    } else if ((pm = /^(rhs\.)?params\.(\w+)$/.exec(rest))) {
      const operand: any = pm[1] ? c.rhs : c.lhs;
      if (pm[2] === "window") {
        if (!/^\d+W$/i.test(String(value))) throw new AnswerError('window must look like "8W"');
        operand.params.window = String(value).toUpperCase();
      } else {
        const meta = INDICATORS[operand.ind]?.required_params.find((q) => q.name === pm![2]);
        if (!meta) throw new AnswerError(`${operand.ind} has no parameter ${pm[2]}`);
        if (meta.type === "enum") {
          if (!meta.values?.includes(String(value))) throw new AnswerError(`must be one of ${meta.values?.join(", ")}`);
          operand.params[pm[2]] = String(value);
        } else {
          const n = numberOf(value);
          if ((meta.min !== undefined && n < meta.min) || (meta.max !== undefined && n > meta.max)) throw new AnswerError(`must be between ${meta.min} and ${meta.max}`);
          if (meta.type === "int" && !Number.isInteger(n)) throw new AnswerError("must be a whole number");
          operand.params[pm[2]] = n;
        }
      }
    } else if ((pm = /^value(?:\.(\d))?$/.exec(rest))) {
      const n = numberOf(value);
      if (pm[1] !== undefined) {
        const arr = Array.isArray(c.value) ? c.value : [null, null];
        arr[Number(pm[1])] = n; c.value = arr;
      } else c.value = n;
    } else if (rest === "rhs_mult") {
      const n = numberOf(value);
      if (n <= 0) throw new AnswerError("the multiple must be positive");
      c.rhs_mult = n;
    } else if (rest === "within_bars" || rest === "bars") {
      const n = numberOf(value);
      if (!Number.isInteger(n) || n < 1) throw new AnswerError("must be a whole number of at least 1");
      (c as any)[rest] = n;
    } else if (rest === "rhs") {
      throw new AnswerError("name the second indicator in the prompt and compile again");
    } else {
      throw new AnswerError(`cannot answer ${path}`);
    }
  } else if ((m = /^actions\.(A\d+)\.(.+)$/.exec(path))) {
    const a: any = p.actions.find((x) => x.id === m![1])!;
    const rest = m[2];
    if (rest === "entry.at") { check(value, enumVals(ENTRY_OPTIONS)); a.entry = { ...(a.entry ?? {}), at: value }; }
    else if (rest === "confidence.method") { check(value, enumVals(CONFIDENCE_OPTIONS)); a.confidence = { ...(a.confidence ?? {}), method: value }; }
    else if (rest === "confidence.n_weeks") { a.confidence = { ...(a.confidence ?? {}), n_weeks: positiveInt(value) }; }
    else if (rest === "highlight.metric") { check(value, enumVals(METRIC_OPTIONS)); a.highlight = { ...(a.highlight ?? {}), metric: value, rule: {} }; }
    else if (rest === "highlight.lookback_weeks") { a.highlight = { ...a.highlight, lookback_weeks: positiveInt(value) }; }
    else if ((m = /^highlight\.rule\.(rs_gt|top_k|gt)$/.exec(rest))) { a.highlight = { ...a.highlight, rule: { ...(a.highlight.rule ?? {}), [m[1]]: m[1] === "top_k" ? positiveInt(value) : numberOf(value) } }; }
    else if (rest === "stop.from") {
      const ok = p.conditions.some((c) => c.id === value && "ind" in c.lhs && INDICATORS[(c.lhs as any).ind]?.can_supply_stop);
      if (!ok) throw new AnswerError("that condition cannot supply a stop");
      a.stop = { from: value };
    } else if (rest === "shift.weeks") { const n = numberOf(value); if (n >= 0) throw new AnswerError("use a negative number of weeks (e.g. -1)"); a.shift = { weeks: n }; }
    else if (rest === "horizons_w") {
      const arr = (Array.isArray(value) ? value : String(value).split(/[,\s]+/).filter(Boolean)).map(positiveInt);
      if (!arr.length) throw new AnswerError("give at least one horizon in weeks");
      a.horizons_w = arr;
    } else if (rest === "set") {
      const opts = item.options?.map((o) => o.value) ?? p.sets.map((s) => s.id);
      check(value, opts);
      a.set = value;
    } else if (rest === "n") { a.n = positiveInt(value); }
    else throw new AnswerError(`cannot answer ${path}`);
  } else if (path === "universe.source") {
    check(value, ["nse_all", "index", "list"]);
    p.universe = { source: value as any };
  } else {
    throw new AnswerError(`cannot answer ${path}`);
  }

  p.needs_input = p.needs_input.filter((n) => n.path !== path);
  if (!p.answers.some((x) => x.path === path)) p.answers.push({ path });
  return addFollowUps(p);
}

function check(value: unknown, allowed: unknown[]) {
  if (!allowed.some((a) => JSON.stringify(a) === JSON.stringify(value))) throw new AnswerError("choose one of the offered options");
}
function positiveInt(v: unknown): number {
  const n = numberOf(v);
  if (!Number.isInteger(n) || n < 1) throw new AnswerError("must be a whole number of at least 1");
  return n;
}

// An answer can open further questions (e.g. a chosen outperformance metric needs its own rule).
export function addFollowUps(p: ScreenProgram): ScreenProgram {
  const have = new Set(p.needs_input.map((n) => n.path));
  const add = (path: string) => { if (!have.has(path)) { have.add(path); p.needs_input.push({ path, reason: "missing" } as NeedsInputV5); } };
  const answered = new Set(p.answers.map((a) => a.path));
  for (const a of p.actions as any[]) {
    const h = a.highlight;
    if (a.type === "group_by" && h?.metric) {
      const need = (k: string, has: boolean) => { if (!has && !answered.has(`actions.${a.id}.${k}`)) add(`actions.${a.id}.${k}`); };
      if (h.metric !== "share_of_qualifiers_vs_universe") need("highlight.lookback_weeks", h.lookback_weeks != null);
      if (h.metric === "sector_return_vs_benchmark") { need("highlight.rule.rs_gt", h.rule?.rs_gt != null); need("highlight.rule.top_k", h.rule?.top_k != null); }
      if (h.metric === "median_return_of_qualifiers") need("highlight.rule.top_k", h.rule?.top_k != null);
      if (h.metric === "share_of_qualifiers_vs_universe") need("highlight.rule.gt", h.rule?.gt != null);
    }
    if (a.type === "trade_plan" && a.confidence?.method === "historical_hit_rate" && a.confidence.n_weeks == null) add(`actions.${a.id}.confidence.n_weeks`);
  }
  return p;
}

// Nothing is ever asked (docs/prompt-interpreter-spec.md §2): the only thing that can stop a run is a prompt
// from which no rule at all could be built. Unresolved/unsupported/not-understood parts are greyed out
// elsewhere and the rest of the screen runs.
export function programConfirmProblems(p: ScreenProgram): string[] {
  return p.conditions.length === 0 ? ["no part of the prompt could be turned into a rule to screen on"] : [];
}

export function ignoreClause(p: ScreenProgram, clauseId: string): ScreenProgram {
  const q = clone(p);
  const u = q.unrecognised.find((x) => x.clause_id === clauseId);
  if (!u) throw new AnswerError("that clause is already understood");
  q.unrecognised = q.unrecognised.filter((x) => x.clause_id !== clauseId);
  q.ignored.push({ text: u.text, reason: "ignored by you" });
  return q;
}
