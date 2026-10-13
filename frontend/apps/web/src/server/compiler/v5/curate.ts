// KB curator (plan §6, P4): an unknown term is researched into a `proposed` knowledge-repository entry.
// The model only fills a schema from a text extract; the entry is then validated like any hand-written one,
// can never collide with an existing entry or alias, and is never marked implemented or reviewed.
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { KbEntrySchema, kbEntries, norm, type IndicatorKb } from "spec/src/kb";
import { callClaude } from "@/server/compiler/callModel";
import type { CallModelFn } from "./fallback";

export const CurateSchema = z.object({
  is_indicator: z.boolean(),
  label: z.string().min(1),
  aliases: z.array(z.string()).max(8),
  category: z.enum(["trend", "momentum", "volatility", "volume", "return", "other"]),
  unit: z.enum(["price", "oscillator_0_100", "oscillator", "volume", "percent", "ratio"]),
  params: z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9_]*$/), label: z.string(), type: z.enum(["int", "float"]), min: z.number(), max: z.number(), common_values: z.array(z.number()).max(6) })).max(5),
  outputs: z.array(z.string()).min(1).max(5),
  warmup_bars: z.string(),
});
export const CURATE_JSON_SCHEMA = zodToJsonSchema(CurateSchema, { $refStrategy: "none" });

export class CurateRejected extends Error {}
export type Snippet = { url: string; text: string };

// default research source: the public Wikipedia summary for the term
export async function wikipediaSnippet(term: string, fetchFn: typeof fetch = fetch): Promise<Snippet | null> {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(term.replace(/\s+/g, "_"))}`;
  const res = await fetchFn(url, { headers: { accept: "application/json" } });
  if (!res.ok) return null;
  const j = (await res.json()) as { extract?: string };
  return j.extract ? { url, text: j.extract } : null;
}

export async function curateTerm(term: string, opts: { callModel?: CallModelFn; snippet: Snippet; now?: Date }): Promise<IndicatorKb> {
  const call = opts.callModel ?? callClaude;
  const system = `You turn a short reference text about a technical-analysis term into a catalogue entry. Use ONLY the text and standard conventions for parameter names; set "is_indicator" false if the term is not a computable indicator. Parameters must be numeric, with a sensible min/max and up to 6 common values. "warmup_bars" is a sum of parameter names and numbers ("length + 1"). Respond with ONLY the JSON object.`;
  const raw = await call(system, `Term: ${term}\nReference text:\n${opts.snippet.text}`, CURATE_JSON_SCHEMA, { task: "curate" });
  const r = CurateSchema.safeParse(JSON.parse(raw));
  if (!r.success) throw new CurateRejected(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const c = r.data;
  if (!c.is_indicator) throw new CurateRejected(`${term} is not a computable indicator`);
  const id = norm(c.label).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const aliases = [...new Set([term, ...c.aliases].map((a) => a.toLowerCase()))];
  const taken = new Set(kbEntries().flatMap((e) => [e.id.replace(/_/g, " "), norm(e.label), ...e.aliases.map(norm)]));
  if (kbEntries().some((e) => e.kind === "indicator" && e.id === id) || aliases.some((a) => taken.has(norm(a)))) throw new CurateRejected(`${term} collides with an existing entry`);
  const entry = {
    kind: "indicator" as const, id, label: c.label, aliases, category: c.category, unit: c.unit,
    params: c.params.map((p, i) => ({ ...p, positional: i, aliases: [], common_values: p.common_values.filter((v) => v >= p.min && v <= p.max) })),
    outputs: c.outputs, operators: [">", ">=", "<", "<=", "between", "outside"], events: [], warmup_bars: c.warmup_bars,
    supports_partial_bar: false, can_supply_stop: false, references: {}, engine: { implemented: false },
    provenance: { sources: [opts.snippet.url], fetched_at: (opts.now ?? new Date()).toISOString().slice(0, 10), status: "proposed" as const, notes: "Curated from a web extract by the model; needs review of parameters, ranges and aliases." },
  };
  const parsed = KbEntrySchema.safeParse(entry);
  if (!parsed.success) throw new CurateRejected(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return parsed.data as IndicatorKb;
}
