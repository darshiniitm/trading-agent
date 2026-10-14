// P4 — model fallback, per clause. Only a clause no recogniser claimed ever reaches the model, and
// only as ONE small schema-constrained call (Ollama structured output) for ONE line. Its answer is
// re-verified exactly like a recogniser's: every phrase must be a substring of that clause and every
// number re-readable from its phrase. Anything that fails twice is "not understood" — never a 422.
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { callClaude, type CallOpts } from "@/server/compiler/callModel";
import { valueTracesToPhrase } from "../spanCheck";
import { INDICATORS } from "./registry";
import { timeframeOf, type CondFrag, type Fragment, type Leaf, type Need, type Tf } from "./recognisers";

const IND_NAMES = Object.keys(INDICATORS) as [string, ...string[]];
const OPS = [">", ">=", "<", "<=", "between", "outside", "flip", "cross_above", "cross_below", "cross_any"] as const;

export const ClauseFragmentSchema = z.object({
  kind: z.enum(["condition", "none"]),
  subject: z.enum(["market_cap", "indicator"]).nullable(),
  indicator: z.enum(IND_NAMES).nullable(),
  // only for a crossover of two indicators on one line ("SMA 6 crosses SMA 30"): the second one
  rhs_indicator: z.enum(IND_NAMES).nullable().optional(),
  timeframe: z.enum(["1D", "1W", "1M"]).nullable(),
  op: z.enum(OPS).nullable(),
  direction: z.enum(["long", "short"]).nullable(),
  // every number the line states, each with the exact words it came from
  args: z.array(z.object({ name: z.string(), value: z.number(), phrase: z.string().min(1) })),
  phrase: z.string().min(1),
});
export type ClauseFragmentOutput = z.infer<typeof ClauseFragmentSchema>;
// A line can state more than one condition ("VStop 10,2 flipped and RSI 50 to 65"): one call, a list.
export const ClauseOutputSchema = z.object({ conditions: z.array(ClauseFragmentSchema).max(4) });
export const CLAUSE_JSON_SCHEMA = zodToJsonSchema(ClauseOutputSchema, { $refStrategy: "none" });

export const FEW_SHOT: { line: string; out: ClauseFragmentOutput }[] = [
  { line: "stocks with market cap from 10,000 to 50,000 crore", out: { kind: "condition", subject: "market_cap", indicator: null, timeframe: null, op: "between", direction: null,
      args: [{ name: "value.0", value: 10000, phrase: "10,000" }, { name: "value.1", value: 50000, phrase: "50,000" }], phrase: "market cap from 10,000 to 50,000 crore" } },
  { line: "weekly RSI(14) is above 60", out: { kind: "condition", subject: "indicator", indicator: "rsi", timeframe: "1W", op: ">", direction: null,
      args: [{ name: "length", value: 14, phrase: "14" }, { name: "value", value: 60, phrase: "60" }], phrase: "RSI(14) is above 60" } },
  { line: "VStop 10,2 turned bullish", out: { kind: "condition", subject: "indicator", indicator: "vstop", timeframe: null, op: "flip", direction: "long",
      args: [{ name: "length", value: 10, phrase: "10" }, { name: "mult", value: 2, phrase: "2" }], phrase: "VStop 10,2 turned bullish" } },
  { line: "the moon is in the seventh house", out: { kind: "none", subject: null, indicator: null, timeframe: null, op: null, direction: null, args: [], phrase: "the moon is in the seventh house" } },
];

export function buildFallbackPrompt(clause: string): { system: string; user: string } {
  const catalog = IND_NAMES.map((n) => `${n}(${INDICATORS[n].positional_params.join(", ")})`).join(", ");
  const system = `You read ONE line of a trader's screening prompt and describe the single condition it states, or say there is none.
Rules:
1. Copy numbers and words ONLY from the line. Never invent, default or guess a value. If the line doesn't state a number, leave it out of "args".
2. Every entry in "args" needs the exact words of the line it came from in "phrase" (a copy-paste substring of the line), and its value must be readable from that phrase.
3. "args" names: an indicator's own parameter names (${catalog}), or "value" for a single threshold, or "value.0" / "value.1" for the low/high of a range ("between"). For the second indicator of a crossover prefix its parameter names with "rhs." (e.g. "rhs.length").
4. Market cap is in crore: "10K" = 10000, "1L" = 100000. subject "market_cap" has no indicator.
5. "conditions" lists each condition the line states on market cap or on indicators (several if it states several). A crossover of two indicators on ONE line uses op cross_above / cross_below / cross_any (either direction) with "indicator" and "rhs_indicator". If the line states none (an instruction, a ranking, or nonsense), answer {"conditions": []}.
6. "timeframe" only if the line itself says daily, weekly or monthly; otherwise null.
Respond with ONLY the JSON object.
Examples:
Line: "SMA 6 crosses above SMA 30 on daily candles"
{"conditions":[{"kind":"condition","subject":"indicator","indicator":"sma","rhs_indicator":"sma","timeframe":"1D","op":"cross_above","direction":null,"args":[{"name":"length","value":6,"phrase":"6"},{"name":"rhs.length","value":30,"phrase":"30"}],"phrase":"SMA 6 crosses above SMA 30"}]}
${FEW_SHOT.map((e) => `Line: ${JSON.stringify(e.line)}\n${JSON.stringify({ conditions: e.out.kind === "none" ? [] : [e.out] })}`).join("\n")}
Line: "weekly VStop 10,2 flipped and RSI 50 to 65"
{"conditions":[{"kind":"condition","subject":"indicator","indicator":"vstop","timeframe":"1W","op":"flip","direction":"long","args":[{"name":"length","value":10,"phrase":"10"},{"name":"mult","value":2,"phrase":"2"}],"phrase":"VStop 10,2 flipped"},{"kind":"condition","subject":"indicator","indicator":"rsi","timeframe":"1W","op":"between","direction":null,"args":[{"name":"value.0","value":50,"phrase":"50"},{"name":"value.1","value":65,"phrase":"65"}],"phrase":"RSI 50 to 65"}]}`;
  return { system, user: `Line: ${JSON.stringify(clause)}` };
}

export class FallbackRejected extends Error {}

export type ToFragmentOpts = { timeframeFromText?: boolean };
export function toFragment(out: ClauseFragmentOutput, text: string, start: number, opts: ToFragmentOpts = {}): Fragment[] {
  if (out.kind === "none") return [];
  // A timeframe is only the model's if the line itself states it; otherwise it is left to the scope line (or a question).
  // (whole-prompt reads leave it null: the scope line sets it, line by line)
  const stated = opts.timeframeFromText === false ? null : timeframeOf(text)?.tf ?? null;
  if (out.timeframe !== stated) out = { ...out, timeframe: stated };
  const locate = (phrase: string, from = 0) => text.toLowerCase().indexOf(phrase.toLowerCase(), from);
  const pi = locate(out.phrase);
  if (pi < 0) throw new FallbackRejected(`phrase ${JSON.stringify(out.phrase)} is not in the line`);
  const at = (i: number, len: number): [number, number] => [start + i, start + i + len];

  const arg = new Map<string, { value: number; leaf: Leaf }>();
  for (const a of out.args) {
    // look inside the condition's own phrase first, so "6" is the 6 the condition was read from
    const inPhrase = locate(a.phrase, pi);
    const i = inPhrase >= 0 && inPhrase + a.phrase.length <= pi + out.phrase.length ? inPhrase : locate(a.phrase);
    if (i < 0) throw new FallbackRejected(`arg phrase ${JSON.stringify(a.phrase)} is not in the line`);
    if (!valueTracesToPhrase(a.value, text.slice(i, i + a.phrase.length))) throw new FallbackRejected(`${a.value} cannot be read from ${JSON.stringify(a.phrase)}`);
    arg.set(a.name, { value: a.value, leaf: { path: a.name.startsWith("value") ? a.name : a.name.startsWith("rhs.") ? `rhs.params.${a.name.slice(4)}` : `params.${a.name}`, phrase: text.slice(i, i + a.phrase.length), span: at(i, a.phrase.length) } });
  }
  const leaves: Leaf[] = [], needs: Need[] = [];
  const phrase = text.slice(pi, pi + out.phrase.length);
  const common = { phrase, span: at(pi, phrase.length) };

  if (out.subject === "market_cap") {
    if (!out.op) throw new FallbackRejected("market cap needs an operator");
    let value: unknown;
    if (out.op === "between" || out.op === "outside") {
      const lo = arg.get("value.0"), hi = arg.get("value.1");
      if (!lo || !hi) throw new FallbackRejected("a range needs both ends");
      value = [lo.value, hi.value]; leaves.push(lo.leaf, hi.leaf);
    } else {
      const v = arg.get("value");
      if (!v) throw new FallbackRejected("a threshold needs its number");
      value = v.value; leaves.push(v.leaf);
    }
    return [{ kind: "condition", lhs: { field: "mcap_cr" }, op: out.op, value, leaves, needs, ...common } as CondFrag];
  }
  if (out.subject === "indicator" && out.indicator) {
    const reg = INDICATORS[out.indicator];
    const params: Record<string, number | string | null> = Object.fromEntries(reg.required_params.map((p) => [p.name, null]));
    for (const p of reg.required_params) {
      const a = arg.get(p.name);
      if (a) { params[p.name] = a.value; leaves.push(a.leaf); }
    }
    const lhs = { ind: out.indicator, params, tf: (out.timeframe as Tf | null) };
    if (out.op === "cross_above" || out.op === "cross_below" || out.op === "cross_any") {
      if (!out.rhs_indicator) throw new FallbackRejected("a crossover needs the second indicator");
      const r = INDICATORS[out.rhs_indicator];
      const rparams: Record<string, number | string | null> = Object.fromEntries(r.required_params.map((p) => [p.name, null]));
      for (const p of r.required_params) {
        const a = arg.get(`rhs.${p.name}`);
        if (a) { rparams[p.name] = a.value; leaves.push(a.leaf); }
      }
      const rhs = { ind: out.rhs_indicator, params: rparams, tf: (out.timeframe as Tf | null) };
      return [{ kind: "condition", lhs, rhs, op: out.op, within_bars: null, emit: out.op === "cross_any" ? ["direction", "event_date"] : ["event_date"], leaves, needs, ...common }];
    }
    if (out.op === "flip") {
      if (!reg.events.includes("flip")) throw new FallbackRejected(`${out.indicator} has no flip event`);
      return [{ kind: "condition", lhs, op: "flip", dir: out.direction ?? "long", within_bars: 1, leaves, needs, ...common }];
    }
    if (!out.op) throw new FallbackRejected("indicator condition needs an operator");
    if (out.op === "between" || out.op === "outside") {
      const lo = arg.get("value.0"), hi = arg.get("value.1");
      if (!lo || !hi) throw new FallbackRejected("a range needs both ends");
      leaves.push(lo.leaf, hi.leaf);
      return [{ kind: "condition", lhs, op: out.op, value: [lo.value, hi.value], leaves, needs, ...common }];
    }
    const v = arg.get("value");
    if (!v) throw new FallbackRejected("a threshold needs its number");
    leaves.push(v.leaf);
    return [{ kind: "condition", lhs, op: out.op, value: v.value, leaves, needs, ...common }];
  }
  throw new FallbackRejected("condition without a subject");
}

export type CallModelFn = (system: string, user: string, format?: object, opts?: CallOpts) => Promise<string>;

// One constrained call + one retry carrying the verification errors. Returns [] ("not understood")
// if the model still can't produce a verifiable fragment.
export function makeClauseFallback(callModel: CallModelFn = callClaude) {
  return async (text: string, start: number): Promise<Fragment[]> => {
    const { system, user } = buildFallbackPrompt(text);
    let errors: string[] = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      const u = attempt === 1 ? user : `${user}\n\nYour previous answer was rejected: ${errors.join("; ")}. Answer again with only the corrected JSON.`;
      const raw = await callModel(system, u, CLAUSE_JSON_SCHEMA, { task: "fallback" });   // a model call that throws (Ollama down) is a real error, not "not understood"
      try {
        const parsed = ClauseOutputSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) { errors = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`); continue; }
        return parsed.data.conditions.flatMap((c) => toFragment(c, text, start));
      } catch (e) {
        errors = [e instanceof FallbackRejected ? e.message : "response was not valid JSON"];
      }
    }
    return [];
  };
}
