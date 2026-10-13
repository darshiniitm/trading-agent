// The interpreter's resolver (docs/prompt-interpreter-spec.md §4). The compiler leaves a `needs_input` entry
// for every value the prompt did not state; instead of asking, fill each one — priority: context within the
// prompt, the user's saved defaults, the indicator's standard settings — and record it as an assumption the
// UI shows as an editable chip. A slot with no sensible fill makes its condition "not evaluable" (greyed out
// with a reason) and the rest of the screen still runs. Nothing is ever asked, and the result has no open
// needs_input, so the engine runs it straight away.
import type { Assumption, NeedsInputV5, NotEvaluable, ScreenProgram } from "spec";
import type { UserDefaults } from "@/server/userDefaults";
import { AnswerError, addFollowUps, applyProgramAnswer } from "./answer";
import { dropLeaf } from "./liquidity";
import { CONFIDENCE_OPTIONS, ENTRY_OPTIONS, METRIC_OPTIONS, TF_OPTIONS, optionsFor } from "./questions";
import { FIELDS, indLabel, paramMeta } from "./registry";

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

// An indicator's standard settings (priority 3). Only the parameters with a conventional value are listed.
export const STANDARD_SETTINGS: Record<string, Record<string, number>> = {
  rsi: { length: 14 }, adx: { length: 14 }, sma: { length: 20 }, ema: { length: 20 }, atr: { length: 14 },
  vstop: { length: 10, mult: 2 }, supertrend: { length: 10, mult: 3 }, macd: { fast: 12, slow: 26, signal: 9 },
  bollinger: { length: 20, mult: 2 }, volume_avg: { length: 20, skip: 0 }, return_n: { bars: 1 }, dist_52w_high: { lookback: 52 },
};
const TRADED_VALUE_WINDOW = "8W";
// "Outperforming" = sector return above the benchmark's; top_k is large so every sector above it is flagged.
const ALL_SECTORS = 100;
const HIGHLIGHT_DEFAULTS = { lookback_weeks: 1, rs_gt: 0, top_k: ALL_SECTORS, gt: 1, median_top_k: 3, hit_rate_weeks: 13 };

type Ctx = { p: ScreenProgram; defaults: UserDefaults; assumptions: Assumption[]; notEval: NotEvaluable[] };

const condOf = (p: ScreenProgram, id: string) => p.conditions.find((c) => c.id === id);
const condName = (c: ScreenProgram["conditions"][number] | undefined) => {
  const o: any = c?.lhs;
  return !o ? "this condition" : "ind" in o ? indLabel(o.ind) : FIELDS[o.field]?.label ?? o.field;
};

function dropCondition(cx: Ctx, id: string, reason: string) {
  const c = condOf(cx.p, id);
  if (!c) return;
  cx.notEval.push({ id, text: c.phrase ?? id, reason, condition: clone(c) });
  cx.p.conditions = cx.p.conditions.filter((x) => x.id !== id);
  cx.p.sets.forEach((s) => { s.where = dropLeaf(s.where, id); });
  const mine = `conditions.${id}.`;
  cx.p.needs_input = cx.p.needs_input.filter((n) => !n.path.startsWith(mine));
  cx.p.source_phrases = cx.p.source_phrases.filter((s) => !s.path.startsWith(mine));
  cx.p.answers = cx.p.answers.filter((a) => !a.path.startsWith(mine));
  cx.assumptions = cx.assumptions.filter((a) => !a.path.startsWith(mine));
}

function dropAction(cx: Ctx, id: string, reason: string) {
  const a = cx.p.actions.find((x) => x.id === id);
  if (!a) return;
  cx.notEval.push({ id, text: String((a as any).type ?? id), reason });
  cx.p.actions = cx.p.actions.filter((x) => x.id !== id);
  cx.p.needs_input = cx.p.needs_input.filter((n) => !n.path.startsWith(`actions.${id}.`));
}

// Apply `value` at `path` through the same validated setter a user's answer would go through, but record it
// as an assumption (never as the user's own answer).
function fill(cx: Ctx, n: NeedsInputV5, value: unknown, label: string, provenance: "assumed" | "inferred", options?: Assumption["options"]) {
  const answersBefore = cx.p.answers;
  cx.p = applyProgramAnswer(cx.p, n.path, value);
  cx.p.answers = answersBefore;
  cx.assumptions = cx.assumptions.filter((a) => a.path !== n.path);
  const opts = options ?? n.options ?? optionsFor(n.path, cx.p);
  cx.assumptions.push({ path: n.path, label, value, provenance, ...(opts ? { options: opts.map((o) => ({ label: o.label, value: o.value })) } : {}) });
}

function resolveOne(cx: Ctx, n: NeedsInputV5) {
  const { p, defaults } = cx;
  let m: RegExpExecArray | null;

  if ((m = /^conditions\.(C\d+)\.(.+)$/.exec(n.path))) {
    const [, id, rest] = m;
    const c = condOf(p, id);
    if (!c) { p.needs_input = p.needs_input.filter((x) => x.path !== n.path); return; }
    if (n.reason === "placeholder") return dropCondition(cx, id, `you wrote "${n.token ?? "?"}" but no value was given for ${condName(c)}`);
    if ((n.reason === "contradiction" || n.reason === "ambiguous") && n.options?.length) {
      // read the prompt literally: the first reading is used, the others stay one click away
      return fill(cx, n, n.options[0].value, `${condName(c)}: ${n.options[0].label}`, "assumed");
    }
    if (rest === "tf") {
      const others = new Set(p.conditions.filter((x) => x.id !== id).flatMap((x) => [(x.lhs as any).tf, (x.rhs as any)?.tf]).filter(Boolean));
      return others.size >= 1
        ? fill(cx, n, [...others][0], `${condName(c)} timeframe`, "inferred", TF_OPTIONS)
        : fill(cx, n, defaults.timeframe, `${condName(c)} timeframe`, "assumed", TF_OPTIONS);
    }
    const pm = /^(rhs\.)?params\.(\w+)$/.exec(rest);
    if (pm) {
      const operand: any = pm[1] ? c.rhs : c.lhs;
      const name = pm[2];
      if (name === "window") return fill(cx, n, TRADED_VALUE_WINDOW, `${condName(c)} window`, "assumed");
      if (name === "source") return fill(cx, n, defaults.price_source, `${condName(c)} price source`, "assumed");
      const std = STANDARD_SETTINGS[operand?.ind]?.[name];
      if (std !== undefined) return fill(cx, n, std, `${condName(c)} ${paramMeta(operand.ind, name)?.label ?? name}`, "assumed");
      return dropCondition(cx, id, `no standard setting for ${condName(c)} ${name}`);
    }
    if (/^value(\.\d)?$/.test(rest)) return dropCondition(cx, id, `no value given to compare ${condName(c)} against`);
    if (rest === "rhs") return dropCondition(cx, id, `nothing to compare ${condName(c)} against`);
    return dropCondition(cx, id, `${condName(c)}: ${n.reason} (${rest})`);
  }

  if ((m = /^actions\.(A\d+)\.(.+)$/.exec(n.path))) {
    const [, id, rest] = m;
    const a: any = p.actions.find((x) => x.id === id);
    if (!a) { p.needs_input = p.needs_input.filter((x) => x.path !== n.path); return; }
    const lbl = (s: string) => `${a.type.replace("_", " ")} ${s}`;
    if (rest === "set") {
      const first = n.options?.[0];
      return first ? fill(cx, n, first.value, lbl("scope"), "assumed") : dropAction(cx, id, "no set of stocks to apply it to");
    }
    if (rest === "entry.at") return fill(cx, n, defaults.entry_recheck === "monday_open" ? "next_open" : "signal_close", "entry price (EP)", "assumed", ENTRY_OPTIONS);
    if (rest === "confidence.method") {
      const hasRsi = p.conditions.some((c) => "ind" in c.lhs && (c.lhs as any).ind === "rsi");
      return fill(cx, n, hasRsi ? "rsi_band_and_stop_distance" : "conditions_met_count", "confidence", "assumed", CONFIDENCE_OPTIONS);
    }
    if (rest === "confidence.n_weeks") return fill(cx, n, HIGHLIGHT_DEFAULTS.hit_rate_weeks, "hit-rate weeks", "assumed");
    if (rest === "highlight.metric") return fill(cx, n, "sector_return_vs_benchmark", "outperforming metric", "assumed", METRIC_OPTIONS);
    if (rest === "highlight.lookback_weeks") return fill(cx, n, HIGHLIGHT_DEFAULTS.lookback_weeks, "sector lookback (weeks)", "assumed");
    if (rest === "highlight.rule.rs_gt") return fill(cx, n, HIGHLIGHT_DEFAULTS.rs_gt, "must beat benchmark by", "assumed");
    if (rest === "highlight.rule.top_k") {
      const median = a.highlight?.metric === "median_return_of_qualifiers";
      return fill(cx, n, median ? HIGHLIGHT_DEFAULTS.median_top_k : HIGHLIGHT_DEFAULTS.top_k, "top sectors highlighted", "assumed");
    }
    if (rest === "highlight.rule.gt") return fill(cx, n, HIGHLIGHT_DEFAULTS.gt, "share multiple", "assumed");
    if (rest === "stop.from") {
      const opts = (n.options ?? []).map((o) => ({ label: o.label, value: o.value }));
      const vstop = p.conditions.find((c) => "ind" in c.lhs && (c.lhs as any).ind === "vstop");
      const pick = vstop ? opts.find((o) => o.value === vstop.id) ?? { label: `${vstop.id}`, value: vstop.id } : opts[0];
      if (pick) return fill(cx, n, pick.value, "stop loss (SL) from", "assumed", opts.length ? opts : undefined);
      delete a.stop;
      cx.notEval.push({ id, text: "stop loss", reason: "no stop-capable indicator (such as VStop) in the prompt to take the stop from" });
      p.needs_input = p.needs_input.filter((x) => x.path !== n.path);
      return;
    }
    if (rest === "shift.weeks") return fill(cx, n, -1, "re-run weeks back", "assumed");
    if (rest === "horizons_w") return fill(cx, n, defaults.horizons_weeks, "return horizons (weeks)", "assumed");
    return dropAction(cx, id, `${lbl("")}: ${n.reason} (${rest})`);
  }

  if (n.path === "universe.source") return fill(cx, n, defaults.universe, "universe", "assumed", [{ label: "all NSE stocks", value: "nse_all" }]);

  // anything else the compiler could not settle: report it, never ask
  cx.notEval.push({ id: n.path, text: n.path, reason: n.reason });
  p.needs_input = p.needs_input.filter((x) => x.path !== n.path);
}

export function resolveProgram(program: ScreenProgram, defaults: UserDefaults): ScreenProgram {
  const cx: Ctx = { p: clone(program), defaults, assumptions: clone(program.assumptions ?? []), notEval: clone(program.not_evaluable ?? []) };
  // text no rule could be built from is greyed out with its reason; it never blocks the run
  for (const u of cx.p.unrecognised) cx.notEval.push({ id: u.clause_id, text: u.text, reason: "could not be turned into a rule" });
  for (const u of cx.p.unsupported) cx.notEval.push({ id: "unsupported", text: u.text, reason: u.reason });
  cx.p.unrecognised = []; cx.p.unsupported = [];

  for (let pass = 0; pass < 6 && cx.p.needs_input.length > 0; pass++) {
    for (const n of [...cx.p.needs_input]) {
      if (!cx.p.needs_input.some((x) => x.path === n.path)) continue;   // dropped along with its condition/action
      try { resolveOne(cx, n); }
      catch (e) {
        if (!(e instanceof AnswerError)) throw e;
        cx.p.needs_input = cx.p.needs_input.filter((x) => x.path !== n.path);
        cx.notEval.push({ id: n.path, text: n.path, reason: e.message });
      }
    }
    cx.p = addFollowUps(cx.p);
  }
  cx.p.needs_input = [];
  // a set whose timeframe could only be known once the conditions' timeframes were filled in
  for (const s of cx.p.sets) {
    if (!s.eval || s.eval.timeframe) continue;
    const ids = ((s.where as any).all ?? []) as string[];
    const tfs = new Set(ids.map((id) => (condOf(cx.p, id)?.lhs as any)?.tf).filter(Boolean));
    if (tfs.size === 1) { const tf = [...tfs][0] as "1D" | "1W" | "1M"; s.eval = { ...s.eval, timeframe: tf, mode: tf === "1D" ? "latest" : "literal" }; }
  }
  cx.p.assumptions = cx.assumptions.sort((a, b) => a.path.localeCompare(b.path));
  cx.p.not_evaluable = cx.notEval;
  return cx.p;
}

function editedLabel(p: ScreenProgram, path: string, fallback: string): string {
  let m: RegExpExecArray | null;
  if ((m = /^conditions\.(C\d+)\.(rhs\.)?params\.(\w+)$/.exec(path))) {
    const c = p.conditions.find((x) => x.id === m![1]);
    const operand: any = m[2] ? c?.rhs : c?.lhs;
    return `${condName(c)} ${(operand?.ind && paramMeta(operand.ind, m[3])?.label) || m[3]}`;
  }
  if ((m = /^conditions\.(C\d+)\.value$/.exec(path))) return `${condName(p.conditions.find((x) => x.id === m![1]))} cut-off`;
  return fallback;
}

// A chip edit: the user replaces an assumed value. Goes through the same validated setter, becomes the
// user's own answer (no longer an assumption), and anything the new value opens up is re-resolved.
export function applyChipEdit(program: ScreenProgram, path: string, value: unknown, defaults: UserDefaults): ScreenProgram {
  const chip = (program.assumptions ?? []).find((a) => a.path === path);
  if (!chip) throw new AnswerError(`there is no assumed value at ${path}`);
  let p = clone(program);
  p.needs_input = [...p.needs_input, { path, reason: "missing", ...(chip.options ? { options: chip.options } : {}) } as NeedsInputV5];
  p = applyProgramAnswer(p, path, value);
  p.assumptions = (p.assumptions ?? []).filter((a) => a.path !== path && !(path.endsWith("highlight.metric") && a.path.startsWith(path.replace(/metric$/, "rule."))));
  const resolved = resolveProgram(p, defaults);
  // The new value stays visible as an "edited" chip: it can be changed again, and the label no longer quotes the old number.
  const edited: Assumption = { path, label: editedLabel(resolved, path, chip.label), value, provenance: "edited", ...(chip.options ? { options: chip.options } : {}) };
  resolved.assumptions = [...(resolved.assumptions ?? []).filter((a) => a.path !== path), edited].sort((a, b) => a.path.localeCompare(b.path));
  return resolved;
}
