import { z } from "zod";

// ScreenProgram v5 — the IR the prompt compiler targets (docs/prompt-compiler-any-prompt-plan.md §2).
// Draft-level: a value the prompt didn't state is `null` and listed in needs_input; the engine
// refuses to run a program that still has any.

export const TfSchema = z.enum(["1D", "1W", "1M"]);
export type Tf = z.infer<typeof TfSchema>;

export const UniverseSchema = z.object({
  source: z.enum(["nse_all", "index", "list"]),
  index: z.string().optional(),
  list: z.string().optional(),
  symbols: z.array(z.string()).optional(),
}).strict();

export const FieldOperandSchema = z.object({
  field: z.enum(["mcap_cr", "traded_value_cr", "price", "volume", "sector", "rs_rating"]),
  params: z.record(z.any()).optional(),
}).strict();

export const IndOperandSchema = z.object({
  ind: z.string().min(1),
  params: z.record(z.any()),
  tf: TfSchema.nullable(),
  output: z.string().optional(),
}).strict();

export const OperandSchema = z.union([FieldOperandSchema, IndOperandSchema]);

export const ProgramConditionSchema = z.object({
  id: z.string().regex(/^C\d+$/),
  lhs: OperandSchema,
  op: z.string().nullable(),
  value: z.any().optional(),
  rhs: IndOperandSchema.nullable().optional(),
  rhs_mult: z.number().positive().optional(),   // compare against rhs x this ("at least 30% above the 52-week low" = x1.30)
  dir: z.enum(["long", "short"]).optional(),
  within_bars: z.number().int().min(1).nullable().optional(),
  bars: z.number().int().min(1).optional(),
  emit: z.array(z.enum(["direction", "event_date"])).optional(),
  phrase: z.string().optional(), // the condition's own words, used to match "from stocks flipped on …" references
}).strict();

export const WhereSchema: z.ZodType<any> = z.lazy(() => z.union([
  z.string().regex(/^C\d+$/),
  z.object({ all: z.array(WhereSchema) }).strict(),
  z.object({ any: z.array(WhereSchema) }).strict(),
  z.object({ not: z.union([WhereSchema, z.array(WhereSchema)]) }).strict(),
]));

export const SetSchema = z.object({
  id: z.string().regex(/^S\d+$/),
  from: z.string(),
  label: z.string().optional(),
  eval: z.object({
    mode: z.enum(["literal", "t1_literal", "latest"]),
    timeframe: TfSchema.nullable().optional(),
    bar: z.literal("last_completed").optional(),
    t1_window: z.object({ length_sessions: z.number().int().min(1), offsets: z.array(z.number().int()) }).optional(),
  }).strict().optional(),
  where: WhereSchema,
  near_miss: z.object({ max_failed: z.number().int().min(0) }).strict().optional(),
}).strict();

export const ActionSchema = z.object({
  id: z.string().regex(/^A\d+$/),
  type: z.enum(["group_by", "rank", "trade_plan", "validate", "limit"]),
}).passthrough();

export const SourcePhraseV5Schema = z.object({
  path: z.string().min(1),
  phrase: z.string().min(1),
  span: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
}).strict();

export const NeedsInputReasonSchema = z.enum(["missing", "placeholder", "ambiguous", "contradiction"]);
export const NeedsInputV5Schema = z.object({
  path: z.string().min(1),
  reason: NeedsInputReasonSchema,
  token: z.string().optional(),     // placeholder: the text the user wrote (e.g. "X")
  phrase: z.string().optional(),    // ambiguous / contradiction: the user's own words
  options: z.array(z.object({ label: z.string(), value: z.any() }).strict()).optional(),
}).strict();
export type NeedsInputV5 = z.infer<typeof NeedsInputV5Schema>;

// Interpreter (docs/prompt-interpreter-spec.md): a slot the prompt left open is filled from context, the
// user's saved defaults or the indicator's standard settings, and recorded here — never asked about.
export const ProvenanceSchema = z.enum(["stated", "inferred", "assumed", "n/a"]);
export type Provenance = z.infer<typeof ProvenanceSchema>;
export const AssumptionSchema = z.object({
  path: z.string().min(1),
  label: z.string(),
  value: z.any(),
  provenance: z.enum(["inferred", "assumed", "edited"]),   // "edited": the user changed it; it stays a chip so it can be changed again
  options: z.array(z.object({ label: z.string(), value: z.any() }).strict()).optional(),
}).strict();
export type Assumption = z.infer<typeof AssumptionSchema>;
export const NotEvaluableSchema = z.object({
  id: z.string(),                       // condition / action id, or the clause id for text no rule could be built from
  text: z.string(),
  reason: z.string().min(1),
  condition: z.any().optional(),        // the rule as far as it could be built (greyed-out row)
}).strict();
export type NotEvaluable = z.infer<typeof NotEvaluableSchema>;

export const ScreenProgramSchema = z.object({
  program_version: z.literal(5),
  universe: UniverseSchema,
  sets: z.array(SetSchema),
  conditions: z.array(ProgramConditionSchema),
  actions: z.array(ActionSchema),
  source_phrases: z.array(SourcePhraseV5Schema),
  needs_input: z.array(NeedsInputV5Schema),
  unsupported: z.array(z.object({ text: z.string().min(1), reason: z.string().min(1) }).strict()),
  ignored: z.array(z.object({ text: z.string(), reason: z.string() }).strict()),
  unrecognised: z.array(z.object({ clause_id: z.string(), text: z.string(), span: z.tuple([z.number(), z.number()]) }).strict()),
  answers: z.array(z.object({ path: z.string() }).strict()),
  assumptions: z.array(AssumptionSchema).optional(),
  not_evaluable: z.array(NotEvaluableSchema).optional(),
}).strict();
export type ScreenProgram = z.infer<typeof ScreenProgramSchema>;
export type ProgramCondition = z.infer<typeof ProgramConditionSchema>;

export const ClauseStatusSchema = z.enum(["ok", "question", "ignored", "not_understood", "model"]);
export const ClauseViewSchema = z.object({
  id: z.string(),
  text: z.string(),
  span: z.tuple([z.number(), z.number()]),
  status: ClauseStatusSchema,
  maps_to: z.string(),
  questions: z.number().int().min(0),
});
export type ClauseView = z.infer<typeof ClauseViewSchema>;
