// Parameter knowledge repository — entry schema (docs/prompt-agent-interpreter-plan.md §2).
// One entry = one thing the interpreter can recognise. Entries start `proposed`; only `reviewed`
// ones are used for matching. `registry.json` (what the compiler and engine read) is GENERATED from
// the implemented entries (generate.ts) — never edited by hand.
import { z } from "zod";

export const StatusSchema = z.enum(["proposed", "reviewed", "retired"]);
export type KbStatus = z.infer<typeof StatusSchema>;

const Provenance = z.object({
  sources: z.array(z.string()),
  // null = written from the reference docs by hand, not machine-fetched
  fetched_at: z.string().nullable(),
  status: StatusSchema,
  notes: z.string().optional(),
});

const Engine = z.object({ implemented: z.boolean(), function: z.string().optional() });

export const ParamSchema = z.object({
  name: z.string(),
  type: z.enum(["int", "float", "enum", "week_window_str"]),
  label: z.string(),
  min: z.union([z.number(), z.string()]).optional(),
  max: z.union([z.number(), z.string()]).optional(),
  values: z.array(z.string()).optional(),
  positional: z.number().int().min(0).optional(),     // "SMA 6" -> params[positional 0] = 6
  aliases: z.array(z.string()).default([]),           // "period", "days" ...
  common_values: z.array(z.union([z.number(), z.string()])).default([]),   // one-tap suggestions only, never auto-filled
});
export type KbParam = z.infer<typeof ParamSchema>;

const base = {
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: z.string(),
  aliases: z.array(z.string()).default([]),
  provenance: Provenance,
};

export const IndicatorEntry = z.object({
  ...base, kind: z.literal("indicator"),
  category: z.enum(["trend", "momentum", "volatility", "volume", "return", "other"]),
  unit: z.enum(["price", "oscillator_0_100", "oscillator", "volume", "percent", "ratio"]),
  params: z.array(ParamSchema),
  outputs: z.array(z.string()),
  operators: z.array(z.string()),
  events: z.array(z.string()),
  // how many bars of history the indicator needs, as a sum of param names / numbers ("slow + signal")
  warmup_bars: z.string(),
  supports_partial_bar: z.boolean().default(false),
  can_supply_stop: z.boolean().default(false),
  references: z.object({ pine: z.string().optional(), talib: z.string().optional(), pandas_ta: z.string().optional() }).default({}),
  engine: Engine,
});

export const FieldEntry = z.object({
  ...base, kind: z.literal("field"),
  unit: z.string(), params: z.array(ParamSchema).default([]),
  data_source: z.string().nullable(), update_frequency: z.string().nullable(),
  engine: Engine,
});

export const UniverseEntry = z.object({
  ...base, kind: z.literal("universe"),
  source: z.enum(["nse_all", "index"]), index: z.string().optional(),
  list_url: z.string().nullable(), snapshot_date: z.string().nullable(),
  engine: Engine,
});

export const OperatorEntry = z.object({
  ...base, kind: z.literal("operator"),
  op: z.string(), phrases: z.array(z.string()), applies_to: z.array(z.enum(["indicator", "field"])),
  engine: Engine,
});

export const TriggerEntry = z.object({
  ...base, kind: z.literal("trigger"),
  phrases: z.array(z.string()), bar_rule: z.string(), window_rule: z.string().nullable(),
  engine: Engine,
});

export const DataRangeEntry = z.object({
  ...base, kind: z.literal("data_range"),
  phrases: z.array(z.string()), timeframe: z.enum(["1D", "1W", "1M"]).nullable(), lookback: z.string().nullable(),
  engine: Engine,
});

export const RankEntry = z.object({
  ...base, kind: z.literal("rank"),
  phrases: z.array(z.string()), key: z.string().nullable(), order: z.enum(["asc", "desc"]).nullable(), limit: z.boolean(),
  engine: Engine,
});

export const KbEntrySchema = z.discriminatedUnion("kind", [IndicatorEntry, FieldEntry, UniverseEntry, OperatorEntry, TriggerEntry, DataRangeEntry, RankEntry]);
export type KbEntry = z.infer<typeof KbEntrySchema>;
export type IndicatorKb = z.infer<typeof IndicatorEntry>;
export type FieldKb = z.infer<typeof FieldEntry>;
export type UniverseKb = z.infer<typeof UniverseEntry>;

export const KbFileSchema = z.object({ entries: z.array(KbEntrySchema) });
