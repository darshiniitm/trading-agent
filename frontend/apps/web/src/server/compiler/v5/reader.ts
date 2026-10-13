// Step 2 — the Reader (docs/prompt-agent-interpreter-plan.md §3, §3.3). One schema-constrained model call over
// the WHOLE prompt, so it can link lines the per-line recognisers cannot ("Calculate SMA 6 and SMA 30" +
// "Detect crossovers"; "them" = the universe above). It only decides which words belong together: every number
// it returns must come with the exact words it was read from, and is re-verified here like a recogniser's
// (span in the prompt, value readable from the span). A mention that fails is dropped and reported.
import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import { callClaude } from "@/server/compiler/callModel";
import { ClauseFragmentSchema, FallbackRejected, toFragment, type CallModelFn } from "./fallback";
import { z as zz } from "zod";
import { INDICATORS } from "./registry";
import { annotationDigest, type Annotation } from "./preannotate";
import type { Fragment } from "./recognisers";
import type { Clause } from "./segment";

// the Reader must always say whether a second indicator is involved (null when not): left optional, a small model omits it
const IND_NAMES = Object.keys(INDICATORS) as [string, ...string[]];
export const ReaderConditionSchema = ClauseFragmentSchema.extend({ rhs_indicator: zz.enum(IND_NAMES).nullable() });
export const ReaderOutputSchema = z.object({ conditions: z.array(ReaderConditionSchema).max(12) });
export const READER_JSON_SCHEMA = zodToJsonSchema(ReaderOutputSchema, { $refStrategy: "none" });

export type Example = { prompt: string; conditions: string[] };
export type ReaderInput = { norm: string; clauses: Clause[]; unresolved: Clause[]; found: string[]; annotations: Annotation[]; issues?: string[]; examples?: Example[] };
export type ReaderResult = { fragments: Fragment[]; dropped: string[]; calls: number };
export type ReaderFn = (input: ReaderInput) => Promise<ReaderResult>;

export function buildReaderPrompt(i: ReaderInput): { system: string; user: string } {
  const catalog = Object.keys(INDICATORS).map((n) => `${n}(${INDICATORS[n].positional_params.join(", ")})`).join(", ");
  const ex = (i.examples ?? []).slice(0, 5).map((e) => `Example prompt: ${JSON.stringify(e.prompt)}\nAccepted reading: ${e.conditions.join(" | ")}`).join("\n");
  const system = `You read a trader's WHOLE screening prompt and describe the conditions stated by the UNRESOLVED lines only.
Lines may depend on each other: a line like "Calculate SMA 6 and SMA 30" defines two series, and a later line "Detect bullish and bearish crossovers" tests them. Combine them into ONE condition.
Rules:
1. Copy numbers and words ONLY from the prompt. Never invent, default or guess a value. If a value isn't stated, leave it out of "args".
2. Every "args" entry needs the exact words it came from in "phrase" (copy-paste substring of the prompt), and its value must be readable from that phrase. For a number, the phrase is JUST the number as written ("6", "30"), not the words around it.
3. "args" names: an indicator's own parameter names (${catalog}); "value" for a threshold; "value.0"/"value.1" for a range; for the SECOND indicator of a crossover prefix with "rhs." (e.g. "rhs.length").
4. A crossover of two series (even if the lines say "moves above", "goes over", "falls under", "overtakes") uses op cross_above (bullish), cross_below (bearish) or cross_any (either direction) with BOTH "indicator" (the first series) and "rhs_indicator" (the second series), and the first series' length in "length" and the second's in "rhs.length". "phrase" is the words of the line that states the event. "rhs_indicator" is null for every condition that is not a crossover.
5. Market cap is in crore: "10K" = 10000, "1L" = 100000.
6. Leave timeframe null unless the SAME line states it.
7. Do not repeat conditions listed as ALREADY UNDERSTOOD. If the unresolved lines state no condition, answer {"conditions": []}.
Respond with ONLY the JSON object.${ex ? `\nSimilar prompts you read before, as accepted by the user:\n${ex}` : ""}`;
  const user = [
    `Prompt lines (with what tools already tagged):\n${annotationDigest(i.clauses, i.annotations)}`,
    `UNRESOLVED lines: ${i.unresolved.map((c) => c.id).join(", ")}`,
    `ALREADY UNDERSTOOD: ${i.found.length ? i.found.join("; ") : "(nothing)"}`,
    ...(i.issues?.length ? [`A reviewer found these problems with the previous reading — fix them: ${i.issues.join("; ")}`] : []),
    `Full prompt:\n${i.norm}`,
  ].join("\n\n");
  return { system, user };
}

export function makeReader(callModel: CallModelFn = callClaude): ReaderFn {
  return async (input) => {
    const { system, user } = buildReaderPrompt(input);
    let errors: string[] = [];
    let calls = 0;
    for (let attempt = 1; attempt <= 2; attempt++) {
      calls++;
      const u = attempt === 1 ? user : `${user}\n\nYour previous answer was rejected: ${errors.join("; ")}. Answer again with only the corrected JSON.`;
      const raw = await callModel(system, u, READER_JSON_SCHEMA, { task: "reader" });
      let parsed: z.infer<typeof ReaderOutputSchema>;
      try {
        const r = ReaderOutputSchema.safeParse(JSON.parse(raw));
        if (!r.success) { errors = r.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`); continue; }
        parsed = r.data;
      } catch { errors = ["response was not valid JSON"]; continue; }
      const fragments: Fragment[] = [], dropped: string[] = [];
      for (const c of parsed.conditions) {
        try { fragments.push(...toFragment(c, input.norm, 0, { timeframeFromText: false })); }
        catch (e) { if (e instanceof FallbackRejected) dropped.push(`${c.phrase}: ${e.message}`); else throw e; }
      }
      // retry once only when everything was dropped; a partial result is kept and the rest reported
      if (fragments.length === 0 && dropped.length > 0 && attempt === 1) { errors = dropped; continue; }
      return { fragments, dropped, calls };
    }
    return { fragments: [], dropped: errors, calls };
  };
}
