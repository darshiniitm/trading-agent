// The local model as the safety net (Ollama only). The rule recognisers read what they know; whatever words they left
// over (leftover.ts) go to the model, which answers in the SAME condition language the engine runs — price vs average,
// multiples, windows, outputs, the new indicators — not a reduced one. Nothing the model says is trusted as written:
//   * the answer is constrained to a JSON schema (indicator / op / output names are enums);
//   * every rule is validated against the registry (parameters, ranges, outputs, which indicators have which events);
//   * the "phrase" it quotes must be in the line, and every number must come from that phrase or be a stated conversion
//     (52 weeks = 252 sessions, N% above = 1 + N/100 ...) — anything else is rejected, the model is told why, and asked once more;
//   * what the model adds is listed as assumptions ("read by the local model") so the user sees it and can edit it.
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { callClaude } from "@/server/compiler/callModel";
import type { CallModelFn } from "./fallback";
import { INDICATORS, paramMeta } from "./registry";
import { STANDARD_SETTINGS } from "./resolve";
import { leaf, at, type CondFrag, type Implied, type Leaf, type Tf } from "./recognisers";
import { clauseTimeframe } from "./patterns";
import type { Clause } from "./segment";

// ------------------------------------------------------------------ the answer schema
const IND = Object.keys(INDICATORS).filter((n) => n !== "bar") as [string, ...string[]];
const OPS = [">", ">=", "<", "<=", "==", "between", "outside", "cross_above", "cross_below", "cross_any", "flip", "up_over", "down_over"] as const;

const OperandSchema = z.object({
  kind: z.enum(["indicator", "price", "rs_rating"]),
  indicator: z.enum(IND).nullable(),
  source: z.enum(["open", "high", "low", "close", "volume"]).nullable(),
  params: z.array(z.object({ name: z.string(), value: z.number() })),
  output: z.string().nullable(),
  timeframe: z.enum(["daily", "weekly", "monthly"]).nullable(),
});
export const ModelCondSchema = z.object({
  left: OperandSchema,
  op: z.enum(OPS),
  right: OperandSchema.nullable(),
  value: z.number().nullable(),
  range: z.array(z.number()).max(2).nullable(),
  multiplier: z.number().nullable(),
  within_bars: z.number().int().nullable(),
  bars: z.number().int().nullable(),
  direction: z.enum(["long", "short"]).nullable(),
  phrase: z.string().min(1),
});
export const ModelOutputSchema = z.object({ conditions: z.array(ModelCondSchema).max(8) });
export type ModelCond = z.infer<typeof ModelCondSchema>;
export const MODEL_JSON_SCHEMA = zodToJsonSchema(ModelOutputSchema, { $refStrategy: "none" });

// ------------------------------------------------------------------ validation -> CondFrag
export class ModelRejected extends Error {}
const TF: Record<string, Tf> = { daily: "1D", weekly: "1W", monthly: "1M" };
const NUMS = /\d+(?:\.\d+)?/g;

type Operand = NonNullable<CondFrag["rhs"]> | { field: string; params?: Record<string, unknown> };

/** Numbers a phrase states, plus the conversions the prompt explains (weeks/months -> sessions, N% -> a multiple). */
function derivable(v: number, nums: number[], words: string): boolean {
  if (/\b(twice|double|2x)\b/i.test(words) && v === 2) return true;
  if (/\bthrice|triple\b/i.test(words) && v === 3) return true;
  return nums.some((n) => v === n * 21 || v === n * 5 || (n === 52 && v === 252) || v === 1 + n / 100 || v === 1 - n / 100 || v === n / 100 || v === Math.round(n * 21));
}

/** Conventional values an indicator parameter takes when the words only imply it (never a tuned default). */
const commonFor = (ind: string, name: string): number[] =>
  [STANDARD_SETTINGS[ind]?.[name], ...(name === "lookback" ? [252, 126] : name === "skip" ? [0, 1, 21] : name === "within" ? [5] : name === "shift" ? [26] : name === "tenkan" ? [9] : name === "kijun" ? [26] : name === "span_b" ? [52] : [])]
    .filter((x): x is number => typeof x === "number");

export function toFragment(m: ModelCond, clause: Clause, leftover: string, inheritedTf: Tf | null = null): CondFrag {
  const text = clause.text;
  // The model copies from the LEFTOVER, which has the already-read words cut out, so its quote can span a gap or carry
  // stray punctuation / a leading "and". Find the longest part of it that really is in the line.
  const rx = (words: string[]) => new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s,;:]+"), "i");
  const toks = m.phrase.replace(/^[^\w(]+|[^\w)%]+$/g, "").split(/\s+/).filter(Boolean);
  let probe: RegExpExecArray | null = null;
  for (let drop = 0; drop <= 4 && !probe; drop++) {
    for (let head = 0; head <= drop && !probe; head++) {
      const part = toks.slice(head, toks.length - (drop - head));
      if (part.length >= 2 || (part.length === 1 && /\d/.test(part[0]))) probe = rx(part).exec(text);
    }
  }
  if (!probe) throw new ModelRejected(`phrase ${JSON.stringify(m.phrase)} is not in the line`);
  const pi = probe.index, plen = probe[0].length;
  const phrase = text.slice(pi, pi + plen);
  const nums = [...text.matchAll(NUMS)].map((x) => Number(x[0]));   // the whole line: the quote the model gives can be cut short
  const used = new Set<number>();
  const leaves: Leaf[] = [];
  const implied: Implied[] = [];

  /** A number the model gave: traced to a number token of the phrase, else a stated conversion, else rejected. */
  const num = (path: string, v: number, what: string, common: number[] = []): void => {
    const hit = [...phrase.matchAll(NUMS)].find((x) => Number(x[0]) === v && !used.has(pi + x.index!)) ?? undefined;
    if (hit) { used.add(pi + hit.index!); leaves.push(leaf(clause, path, pi + hit.index!, hit[0])); return; }
    const wide = [...text.matchAll(NUMS)].find((x) => Number(x[0]) === v && !used.has(x.index!));
    if (wide) { used.add(wide.index!); leaves.push(leaf(clause, path, wide.index!, wide[0])); return; }
    if (derivable(v, nums, text) || common.includes(v)) { implied.push({ path, label: `${what} = ${v} (read by the local model from "${phrase.slice(0, 60)}")`, value: v }); return; }
    throw new ModelRejected(`${what} = ${v} is not in the words "${phrase}" and is not a stated conversion`);
  };

  const tfCue = /\b(daily|weekly|monthly|dma|\d+[-\s]?(?:day|week)s?)\b/i.test(text);
  const clauseTf = clauseTimeframe(text) ?? inheritedTf;   // a piece of a line takes the line's (or its sibling rules') timeframe
  const operand = (o: z.infer<typeof OperandSchema>, role: "" | "rhs."): Operand => {
    const tf: Tf | null = (o.timeframe && tfCue ? TF[o.timeframe] : null) ?? clauseTf;
    if (o.kind === "price") {
      implied.push({ path: `${role}params.source`, label: `the ${o.source ?? "close"} (read by the local model)`, value: o.source ?? "close" });
      return { ind: "bar", params: { source: o.source ?? "close" }, tf };
    }
    if (o.kind === "rs_rating") {
      if (role) throw new ModelRejected("RS rating can only be on the left");
      const lb = o.params.find((p) => p.name === "lookback")?.value ?? 252;
      implied.push({ path: "params.lookback", label: "RS rating over 252 sessions", value: lb });
      return { field: "rs_rating", params: { lookback: lb } };
    }
    const reg = o.indicator ? INDICATORS[o.indicator] : undefined;
    if (!reg) throw new ModelRejected(`unknown indicator ${JSON.stringify(o.indicator)}`);
    const params: Record<string, number | string | null> = Object.fromEntries(reg.required_params.map((p) => [p.name, null]));
    for (const p of o.params) {
      const meta = paramMeta(reg.name, p.name);
      if (!meta || meta.type === "enum") { if (meta?.type === "enum") continue; throw new ModelRejected(`${reg.name} has no parameter ${JSON.stringify(p.name)}`); }
      if ((meta.min !== undefined && p.value < meta.min) || (meta.max !== undefined && p.value > meta.max)) throw new ModelRejected(`${reg.name}.${p.name} = ${p.value} is outside [${meta.min}, ${meta.max}]`);
      if (meta.type === "int" && !Number.isInteger(p.value)) throw new ModelRejected(`${reg.name}.${p.name} must be a whole number`);
      num(`${role}params.${p.name}`, p.value, `${reg.label} ${meta.label}`, commonFor(reg.name, p.name));
      params[p.name] = p.value;
    }
    if (o.output && o.output !== "value" && !reg.outputs.includes(o.output)) throw new ModelRejected(`${reg.name} has no output ${JSON.stringify(o.output)} (it has: ${reg.outputs.join(", ")})`);
    return { ind: reg.name, params, tf, ...(o.output && o.output !== "value" ? { output: o.output } : {}) };
  };

  const lhs = operand(m.left, "");
  const rhs = m.right ? (operand(m.right, "rhs.") as NonNullable<CondFrag["rhs"]>) : null;
  if (rhs && JSON.stringify(lhs, (k, v) => (k === "tf" ? undefined : v)) === JSON.stringify(rhs, (k, v) => (k === "tf" ? undefined : v))) {
    throw new ModelRejected("left and right are the same thing: compare it with something else");
  }
  const lind = "ind" in lhs ? INDICATORS[lhs.ind] : undefined;
  const frag: CondFrag = { kind: "condition", lhs: lhs as CondFrag["lhs"], op: m.op, phrase, span: at(clause, pi, plen), leaves, needs: [], implied };
  if (rhs) { (rhs as any).tf = (rhs as any).tf ?? ("ind" in lhs ? lhs.tf : null); frag.rhs = rhs; if ("ind" in lhs && (lhs as any).tf == null) (lhs as any).tf = (rhs as any).tf; }

  switch (m.op) {
    case "between": case "outside":
      if (!m.range || m.range.length !== 2) throw new ModelRejected(`${m.op} needs a range of two numbers`);
      num("value.0", m.range[0], "lower bound"); num("value.1", m.range[1], "upper bound"); frag.value = m.range; break;
    case "cross_above": case "cross_below": case "cross_any": {
      if (!lind || !lind.events.includes(m.op)) throw new ModelRejected(`${"ind" in lhs ? lhs.ind : "that"} cannot cross`);
      if (!rhs && m.value === null) throw new ModelRejected("a crossover needs the other line or a level");
      if (m.value !== null) { num("value", m.value, "level"); frag.value = m.value; }
      if (m.within_bars) num("within_bars", m.within_bars, "window"); else implied.push({ path: "within_bars", label: "crossed in the last bar (no window stated)", value: 1 });
      frag.within_bars = m.within_bars ?? 1; frag.emit = ["event_date"]; break;
    }
    case "flip":
      if (!lind || !lind.events.includes("flip")) throw new ModelRejected(`${"ind" in lhs ? lhs.ind : "that"} has no flip`);
      if (!m.direction) throw new ModelRejected("a flip needs a direction (long or short)");
      if (m.within_bars) num("within_bars", m.within_bars, "window"); else implied.push({ path: "within_bars", label: "flipped on the last bar (no window stated)", value: 1 });
      frag.dir = m.direction; frag.within_bars = m.within_bars ?? 1; frag.emit = ["event_date"]; break;
    case "up_over": case "down_over":
      if (!m.bars) throw new ModelRejected(`${m.op} needs "bars"`);
      num("bars", m.bars, "bars"); frag.bars = m.bars; break;
    default:
      if (!rhs && m.value === null) throw new ModelRejected(`${m.op} needs a number or the other operand`);
      if (m.value !== null) { num("value", m.value, "threshold"); frag.value = m.value; }
  }
  if (m.multiplier !== null && m.multiplier !== 1) {
    if (!rhs) throw new ModelRejected("a multiplier needs the right-hand operand");
    if (!derivable(m.multiplier, nums, text) && !nums.includes(m.multiplier)) throw new ModelRejected(`multiplier ${m.multiplier} is not in the words "${phrase}"`);
    frag.rhs_mult = m.multiplier; implied.push({ path: "rhs_mult", label: `multiple x${m.multiplier} (read by the local model)`, value: m.multiplier });
  }
  return frag;
}

// ------------------------------------------------------------------ the prompt
const MEANING: Record<string, string> = {
  high_n: "highest high of the last `lookback` bars (a 52-week high LEVEL: lookback 252; skip 1 = previous bars only)",
  low_n: "lowest low of the last `lookback` bars (a 52-week low LEVEL: lookback 252)",
  dist_52w_high: "percent distance from the high (NOT the high itself; avoid)",
  volume_avg: "average volume over `length` bars (skip 1 = previous bars only)",
  turnover_avg: "average daily traded value in crore over `length` bars",
  momentum_skip: "return over `lookback` bars skipping the most recent `skip` bars (12-month return excluding last month: 252, 21)",
  gap_up: "today's open divided by yesterday's high minus 1 (0.02 = a 2% gap up)",
  narrow_range: "1 when today's range is the narrowest of the last `length` bars (NR7: 7)", inside_day: "1 when today is an inside day",
  bb_squeeze: "1 when Bollinger bandwidth was at its `lookback`-bar low within the last `within` bars", bollinger: "bands; output upper / lower",
  ichimoku: "output tenkan, kijun, span_a, span_b, cloud_top, cloud_bottom", macd: "output value (MACD line) / signal / hist", adx: "trend strength 0-100",
  supertrend: "flip long = turned green / bullish; flip short = turned red", vstop: "flip long / short",
};
const catalog = () => Object.values(INDICATORS).filter((i) => i.name !== "bar")
  .map((i) => `${i.name}(${i.required_params.map((p) => p.name).join(", ")})${i.outputs.length > 1 ? ` outputs: ${i.outputs.join("/")}` : ""}${i.events.length ? ` events: ${i.events.join("/")}` : ""}${MEANING[i.name] ? ` — ${MEANING[i.name]}` : ""}`).join("\n");

export type ReadExample = { text: string; conditions: ModelCond[] };

export function buildModelPrompt(clauseText: string, understood: string[], leftover: string, examples: ReadExample[]): { system: string; user: string } {
  const system = `You finish reading ONE line of a stock-screener prompt. A tool already turned some of the line into rules. You read ONLY the LEFTOVER words and answer the rules they state. If the leftover states no rule (a title, a strategy name, filler), answer {"conditions": []}.
A rule is: left OP right (or left OP value), with an optional multiplier, window or direction.
- left / right are operands. kind "price" = a bar value: source open / high / low / close / volume (the words "price", "close", "volume"). kind "indicator" = one of the indicators below, params by name (numbers only), "output" when the indicator has several lines. kind "rs_rating" = the RS rating.
- op: > >= < <= == between outside; cross_above / cross_below / cross_any (left crosses right, or a fixed level in "value"); flip + direction (long / short) for vstop and supertrend turning; up_over / down_over (left is higher / lower than it was "bars" bars ago).
- multiplier m: the rule reads left OP right x m ("at least 30% above the 52-week low" = right low_n, multiplier 1.3, op >=).
- within_bars: the crossover or flip happened within the last N bars. A crossover also needs a second rule: the first line is still above (below) the second today.
- timeframe: only if the leftover says daily, weekly or monthly or gives "N-day" / "N-week"; otherwise null.
- phrase: the exact words of the LEFTOVER (a copy-paste substring) this rule comes from.
Numbers: copy every number from the words; never invent one. Allowed conversions: 52 weeks = 252 sessions, 1 month = 21 sessions, 1 week = 5, "N% above" = 1 + N/100, "N% below" = 1 - N/100, "twice" = 2.
A new 52-week high is close > high_n(lookback 252, skip 1). Volume against its average is volume vs volume_avg(skip 1) with a multiplier.
Indicators:
${catalog()}
Answer with ONLY the JSON object.
${examples.map((e) => `Leftover: ${JSON.stringify(e.text)}\n${JSON.stringify({ conditions: e.conditions })}`).join("\n")}`;
  const user = `Full line: ${JSON.stringify(clauseText)}\nALREADY READ (do not repeat): ${understood.length ? understood.join(" | ") : "(nothing)"}\nLEFTOVER: ${JSON.stringify(leftover)}`;
  return { system, user };
}

// ------------------------------------------------------------------ examples taught to the model
// The examples are phrases the rule readers already handle, converted back into the model's own answer format, so
// the model is shown exactly what a correct reading looks like (and the examples can never drift from the compiler).
export const EXAMPLE_PHRASES = [
  "price above the 150 day SMA", "50 DMA crossed above 200 DMA in the last 10 sessions", "at least 30% above the 52-week low",
  "volume at least 2 times the 20-day average", "Supertrend (10,3) turned green in the last 3 days", "RSI crossed above 30 in the last 3 sessions",
  "gap up of 2% above yesterday's high", "MACD (12,26,9) bullish crossover below the zero line in the last 2 sessions",
  "weekly close above a rising 30-week moving average", "price above the Ichimoku cloud", "within 25% of the 52-week high",
];

function operandShape(o: any) {
  if (!o) return null;
  if ("field" in o) return { kind: "rs_rating", indicator: null, source: null, params: [{ name: "lookback", value: o.params?.lookback ?? 252 }], output: null, timeframe: null };
  if (o.ind === "bar") return { kind: "price", indicator: null, source: o.params?.source ?? "close", params: [], output: null, timeframe: o.tf ? ({ "1D": "daily", "1W": "weekly", "1M": "monthly" } as any)[o.tf] : null };
  return { kind: "indicator", indicator: o.ind, source: null, params: Object.entries(o.params ?? {}).filter(([, v]) => typeof v === "number").map(([name, value]) => ({ name, value })),
    output: o.output ?? null, timeframe: o.tf ? ({ "1D": "daily", "1W": "weekly", "1M": "monthly" } as any)[o.tf] : null };
}
export function shapeOf(c: any, phrase: string): ModelCond {
  return {
    left: operandShape(c.lhs) as any, op: c.op, right: operandShape(c.rhs) as any, value: typeof c.value === "number" ? c.value : null,
    range: Array.isArray(c.value) ? c.value : null, multiplier: c.rhs_mult ?? null, within_bars: c.within_bars ?? null, bars: c.bars ?? null,
    direction: c.dir ?? null, phrase,
  };
}

let exampleCache: ReadExample[] | null = null;
export async function readExamples(): Promise<ReadExample[]> {
  if (exampleCache) return exampleCache;
  const { compileProgram } = await import("./compileProgram");
  const out: ReadExample[] = [];
  for (const text of EXAMPLE_PHRASES) {
    const d = await compileProgram(text);
    out.push({ text, conditions: d.program.conditions.map((c) => shapeOf(c, text)) });
  }
  return (exampleCache = out);
}
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z]{3,}|\d+/g) ?? []);
export function pickExamples(all: ReadExample[], leftover: string, n = 5): ReadExample[] {
  const w = words(leftover);
  return [...all].map((e) => ({ e, s: [...words(e.text)].filter((x) => w.has(x)).length })).sort((a, b) => b.s - a.s).slice(0, n).map((x) => x.e);
}

// ------------------------------------------------------------------ the reader
export type ModelReadInput = { clause: Clause; leftover: string; understood: string[]; timeframe?: Tf | null };
export type ModelReadFn = (input: ModelReadInput) => Promise<CondFrag[]>;

/** One constrained call, one retry that carries the rejection reasons. Every rule is validated on its own: the good ones
 *  are kept, only the rejected ones are asked about again. A call that throws (Ollama down) is a real error. */
export function makeModelReader(callModel: CallModelFn = callClaude, opts: { attempts?: number } = {}): ModelReadFn {
  const debug = !!process.env.MODEL_DEBUG;
  return async ({ clause, leftover, understood, timeframe }) => {
    const examples = pickExamples(await readExamples(), leftover);
    const { system, user } = buildModelPrompt(clause.text, understood, leftover, examples);
    const kept: CondFrag[] = [];
    const key = (f: CondFrag) => JSON.stringify({ l: f.lhs, o: f.op, r: f.rhs ?? null, v: f.value ?? null, m: f.rhs_mult ?? null, w: f.within_bars ?? null, b: f.bars ?? null, d: f.dir ?? null }, (k, v) => (k === "tf" ? undefined : v));
    let errors: string[] = [];
    for (let attempt = 1; attempt <= (opts.attempts ?? 2); attempt++) {
      const u = attempt === 1 ? user : `${user}\n\nThese rules of your previous answer were rejected: ${errors.join("; ")}. Answer again with ONLY the corrected rules for the leftover (do not repeat rules that were fine).`;
      const raw = await callModel(system, u, MODEL_JSON_SCHEMA, { task: "modelRead" });
      errors = [];
      let parsed: z.SafeParseReturnType<unknown, z.infer<typeof ModelOutputSchema>>;
      try { parsed = ModelOutputSchema.safeParse(JSON.parse(raw)); } catch { errors = ["response was not valid JSON"]; continue; }
      if (!parsed.success) { errors = parsed.error.issues.slice(0, 4).map((i) => `${i.path.join(".")}: ${i.message}`); continue; }
      for (const c of parsed.data.conditions) {
        try {
          const f = toFragment(c, clause, leftover, timeframe ?? null);
          if (!kept.some((k) => key(k) === key(f))) kept.push(f);
        } catch (e) { errors.push(e instanceof ModelRejected ? e.message : "a rule could not be read"); }
      }
      if (debug) console.error(`[model attempt ${attempt}] kept=${kept.length} rejected=${JSON.stringify(errors)}`);
      if (errors.length === 0) break;
    }
    return kept;
  };
}
