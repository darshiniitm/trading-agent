// Step 6 — the critic (plan §3). Two layers read the prompt next to the plain-English rendering of what
// will run and list anything missing, extra or reversed:
//   ruleCritic  deterministic (indicator/number coverage, direction words, comparator words, rank order);
//   modelCritic a small schema-constrained model task that only compares two texts.
// Neither edits the program; their issues go back to the Reader (max 2 rounds) or onto the line.
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ClauseView, ScreenProgram } from "spec";
import { findMentions, indexOf, type Index } from "spec/src/kb";
import { callClaude } from "@/server/compiler/callModel";
import type { CallModelFn } from "./fallback";
import { amount } from "./recognisers";

export type Issue = { kind: "missing" | "extra" | "reversed"; phrase: string; note: string; source: "rules" | "model" };
export type CriticFn = (norm: string, english: string) => Promise<Issue[]>;

let idx: Index | null = null;
const programNumbers = (p: ScreenProgram): Set<number> => {
  const s = new Set<number>();
  const add = (v: unknown) => { if (typeof v === "number") s.add(v); else if (Array.isArray(v)) v.forEach(add); };
  const conds: any[] = [...p.conditions, ...(p.not_evaluable ?? []).map((n) => n.condition).filter(Boolean)];
  for (const c of conds) {
    add(c.value); add(c.within_bars); add(c.bars); add(c.rhs_mult);
    for (const o of [c.lhs, c.rhs]) if (o?.params) Object.values(o.params).forEach(add);
  }
  for (const a of p.actions as any[]) {
    add(a.n); add(a.horizons_w); add(a.shift?.weeks && Math.abs(a.shift.weeks));
    add(a.stop?.from_atr?.mult); add(a.target?.r_multiple); add(a.highlight?.top_n_per_group);
  }
  // a number the reading derives ("52 weeks = 252 sessions", "within 25% = x0.75") is accounted for by its assumption
  for (const a of p.assumptions ?? []) for (const m of String(a.label).matchAll(/\d+(?:\.\d+)?/g)) s.add(Number(m[0]));
  (p.universe.index ?? "").match(/\d+/g)?.forEach((d) => s.add(Number(d)));
  return s;
};
const indicatorsIn = (p: ScreenProgram): Set<string> => {
  const s = new Set<string>();
  const conds: any[] = [...p.conditions, ...(p.not_evaluable ?? []).map((n) => n.condition).filter(Boolean)];
  for (const c of conds) for (const o of [c.lhs, c.rhs]) if (o && "ind" in o) s.add(o.ind);
  if ((p.actions as any[]).some((a) => a.stop?.from_atr)) s.add("atr");   // an ATR stop on a trade plan uses ATR
  return s;
};

export function ruleCritic(norm: string, clauses: ClauseView[], p: ScreenProgram): Issue[] {
  idx ??= indexOf(["reviewed"]);
  const out: Issue[] = [];
  const push = (kind: Issue["kind"], phrase: string, note: string) => { if (!out.some((i) => i.kind === kind && i.phrase === phrase)) out.push({ kind, phrase, note, source: "rules" }); };
  const live = clauses.filter((c) => c.status !== "ignored" && c.status !== "not_understood" && !/not computable/.test(c.maps_to));
  const nums = programNumbers(p), inds = indicatorsIn(p);

  for (const c of live) {
    for (const h of findMentions(idx, c.text, ["indicator"])) {
      if (!inds.has(h.entry.id)) push("missing", c.text.slice(h.index, h.end), `the prompt names ${h.entry.label} but no rule uses it`);
    }
    // numbers (a universe name's own number is read through the universe)
    const t = c.text.replace(/nifty\s*(?:midcap|smallcap|next)?\s*\d+/gi, " ");
    for (const m of t.matchAll(/(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(k|l)?(?![a-z0-9])/gi)) {   // "10,000" is one number, "10,2" is two
      const mm = /^((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(k|l)?$/i.exec(m[0].trim());
      if (mm && !nums.has(amount(mm[1], mm[2]))) push("missing", m[0].trim(), `the number ${m[0].trim()} is not used by any rule`);
    }
    // comparator words against the condition read from this line
    for (const cond of p.conditions) {
      if (!cond.phrase || !c.text.includes(cond.phrase)) continue;
      const below = /\b(below|under|less than)\b/i.test(cond.phrase), above = /\b(above|over|greater than|more than)\b/i.test(cond.phrase);
      // an event or a derived reading ("crossover below the zero line", "above a rising average") is not a comparator
      const isEvent = (o: { op?: unknown }) => !!o.op && (String(o.op).startsWith("cross") || o.op === "flip" || o.op === "up_over" || o.op === "down_over");
      // a companion the crossover implies ("still above the signal line") carries its parent's phrase, so it shares the event's words
      const derived = isEvent(cond) || p.conditions.some((o) => o !== cond && o.phrase === cond.phrase && isEvent(o));
      if (below && !above && cond.op && !derived && !["<", "<=", "outside"].includes(cond.op)) push("reversed", cond.phrase, `"below" was read as ${cond.op}`);
      if (above && !below && cond.op && !derived && ![">", ">="].includes(cond.op)) push("reversed", cond.phrase, `"above" was read as ${cond.op}`);
    }
  }

  const text = live.map((c) => c.text).join("\n");
  const bull = /\bbullish\b/i.test(text), bear = /\bbearish\b/i.test(text);
  for (const c of p.conditions) {
    if (c.op === "cross_above" || c.op === "cross_below" || c.op === "cross_any") {
      const want = bull && !bear ? "cross_above" : bear && !bull ? "cross_below" : bull && bear ? "cross_any" : null;
      if (want && c.op !== want) push("reversed", bull && !bear ? "bullish" : bear && !bull ? "bearish" : "bullish and bearish", `the prompt asks for ${want} but the rule is ${c.op}`);
    }
    if (c.op === "flip") {
      const shortWord = /\b(short|bearish)\b/i.test(c.phrase ?? "");
      if (shortWord && c.dir !== "short") push("reversed", c.phrase ?? "flip", "the prompt says short/bearish but the rule flips long");
      if (!shortWord && c.dir === "short") push("reversed", c.phrase ?? "flip", "the rule flips short but the prompt does not say short/bearish");
    }
  }
  for (const a of p.actions as any[]) {
    if (a.type !== "rank" || !a.by?.[0]) continue;
    const recent = /\b(most recent|latest|newest)\b/i.exec(text), oldest = /\b(oldest|earliest)\b/i.exec(text);
    if (recent && !oldest && a.by[0].order !== "desc") push("reversed", recent[0], "the prompt wants newest first but the rank is ascending");
    if (oldest && !recent && a.by[0].order !== "asc") push("reversed", oldest[0], "the prompt wants oldest first but the rank is descending");
  }
  void norm;
  return out;
}

export const CriticOutputSchema = z.object({
  issues: z.array(z.object({ kind: z.enum(["missing", "extra", "reversed"]), phrase: z.string().min(1), note: z.string() })).max(10),
});
export const CRITIC_JSON_SCHEMA = zodToJsonSchema(CriticOutputSchema, { $refStrategy: "none" });

export function makeModelCritic(callModel: CallModelFn = callClaude): CriticFn {
  return async (norm, english) => {
    const system = `You compare a trader's screening prompt with a plain-English reading of what will run, and list differences ONLY:
- "missing": the prompt states something the reading leaves out;
- "extra": the reading contains something the prompt never said;
- "reversed": a direction, comparator or order is the opposite of the prompt.
"phrase" must be copied exactly from the PROMPT (for "extra", the words of the reading that are not in the prompt cannot be quoted, so quote the nearest prompt words). Ignore wording differences, rounding and defaults the reading marks as assumed. If they agree, answer {"issues": []}. Respond with ONLY the JSON object.`;
    const user = `PROMPT:\n${norm}\n\nREADING:\n${english}`;
    const raw = await callModel(system, user, CRITIC_JSON_SCHEMA, { task: "critic" });
    try {
      const r = CriticOutputSchema.safeParse(JSON.parse(raw));
      if (!r.success) return [];
      const lower = norm.toLowerCase();
      // an issue that cannot be pointed at in the prompt is dropped, like any unverifiable model claim
      return r.data.issues.filter((i) => lower.includes(i.phrase.toLowerCase())).map((i) => ({ ...i, source: "model" as const }));
    } catch { return []; }
  };
}
