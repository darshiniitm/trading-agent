import { z } from "zod";

export const ConditionSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["filter", "event", "stop"]),
  kind: z.enum(["field", "indicator"]),
  name: z.string().min(1),
  params: z.record(z.any()).default({}),
  op: z.string().min(1),
  value: z.any().optional().nullable(),
  dir: z.literal("long").optional().nullable(),
});
export type Condition = z.infer<typeof ConditionSchema>;

export const SelectionPointSchema = z.object({
  session_of_week: z.number().int().min(1).max(5),
  at: z.enum(["open", "close"]),
});
export type SelectionPoint = z.infer<typeof SelectionPointSchema>;

export const StopSchema = z.object({ from: z.string().min(1) });
export type Stop = z.infer<typeof StopSchema>;

export const NearMissSchema = z.object({ max_failed: z.number().int().min(0) });
export type NearMiss = z.infer<typeof NearMissSchema>;

export const T1WindowSchema = z.object({
  length_sessions: z.number().int().min(1),
  offsets: z.array(z.number().int()),
});
export type T1Window = z.infer<typeof T1WindowSchema>;

export const ScreenSpecSchema = z
  .object({
    spec_version: z.number().int(),
    structure: z.enum(["literal", "t1_literal"]),
    timeframe: z.literal("1W"),
    selection_point: SelectionPointSchema.nullable(),
    conditions: z.array(ConditionSchema),
    stop: StopSchema.nullable(),
    risk_cap_pct: z.number().nullable(),
    near_miss: NearMissSchema.nullable(),
    t1_window: T1WindowSchema.nullable().optional(),
  })
  .superRefine((spec, ctx) => {
    const ids = spec.conditions.map((c) => c.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "condition ids must be unique" });
    }
  });
export type ScreenSpec = z.infer<typeof ScreenSpecSchema>;

export const SourcePhraseSchema = z.object({ path: z.string().min(1), phrase: z.string().min(1) });
export type SourcePhrase = z.infer<typeof SourcePhraseSchema>;

export const NeedsInputItemSchema = z.object({ path: z.string().min(1), question: z.string().min(1) });
export type NeedsInputItem = z.infer<typeof NeedsInputItemSchema>;

export const UnsupportedItemSchema = z.object({ text: z.string().min(1), reason: z.string().min(1) });
export type UnsupportedItem = z.infer<typeof UnsupportedItemSchema>;

export const CompileOutputSchema = z.object({
  structure: z.enum(["literal", "t1_literal"]).nullable(),
  conditions: z.array(ConditionSchema),
  selection_point: SelectionPointSchema.nullable(),
  stop: StopSchema.nullable(),
  risk_cap_pct: z.number().nullable(),
  near_miss: NearMissSchema.nullable(),
  t1_window: T1WindowSchema.nullable(),
  source_phrases: z.array(SourcePhraseSchema),
  needs_input: z.array(NeedsInputItemSchema),
  unsupported: z.array(UnsupportedItemSchema),
});
export type CompileOutput = z.infer<typeof CompileOutputSchema>;
