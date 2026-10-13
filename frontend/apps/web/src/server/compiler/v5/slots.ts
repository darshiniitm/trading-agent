// The 4-slot view of a resolved program (docs/prompt-interpreter-spec.md §3.1): parameter, operator, value
// and trigger point per condition, with a provenance for every slot. Derived from the program and its
// assumption list, so it can never disagree with what the engine actually runs. Stored with every prompt
// version (`prompts.resolved_json`) so a run can be reproduced exactly.
import type { Provenance, ScreenProgram } from "spec";
import type { UserDefaults } from "@/server/userDefaults";
import { INDICATORS } from "./registry";

export type SlotCondition = {
  id: string; source_text: string;
  parameter: { name: string; args: Record<string, unknown>; source: string | null; timeframe: string | null };
  operator: string | null; value: unknown;
  trigger: { timeframe: string | null; bar: string; evaluate_at: string; recheck_at: string | null; lookback_bars: number };
  provenance: Record<"parameter.name" | "parameter.args" | "parameter.source" | "parameter.timeframe" | "operator" | "value" | "trigger", Provenance>;
  evaluable: boolean; not_evaluable_reason: string | null;
};

const TF_NAME: Record<string, string> = { "1D": "daily", "1W": "weekly", "1M": "monthly" };

function operatorOf(c: { op: string | null; dir?: string }): string | null {
  switch (c.op) {
    case "flip": return c.dir === "short" ? "flips_short" : "flips_long";
    case "cross_above": return "crosses_above";
    case "cross_below": return "crosses_below";
    case "cross_any": return "crosses_any";
    case "rising": return "rising_n";
    case "falling": return "falling_n";
    default: return c.op;
  }
}

export function toSlotConditions(program: ScreenProgram, defaults: UserDefaults): SlotCondition[] {
  const assumed = new Map((program.assumptions ?? []).map((a) => [a.path, a.provenance]));
  const worst = (paths: string[]): Provenance => {
    const ps = paths.map((p) => assumed.get(p)).filter(Boolean);
    return ps.includes("assumed") ? "assumed" : ps.includes("inferred") ? "inferred" : "stated";
  };
  const build = (c: any, evaluable: boolean, reason: string | null): SlotCondition => {
    const lhs = c.lhs;
    const isInd = "ind" in lhs;
    const params: Record<string, unknown> = { ...(lhs.params ?? {}) };
    const source = isInd ? (params.source as string | undefined) ?? null : null;
    delete params.source;
    const tf = isInd ? lhs.tf : null;
    const base = `conditions.${c.id}.`;
    const argPaths = Object.keys(params).map((k) => `${base}params.${k}`);
    const eventOp = ["flip", "cross_above", "cross_below", "cross_any", "rising", "falling"].includes(c.op ?? "");
    const hasSource = isInd && INDICATORS[lhs.ind]?.required_params.some((p) => p.name === "source");
    return {
      id: c.id, source_text: c.phrase ?? "",
      parameter: { name: isInd ? lhs.ind : lhs.field, args: params, source, timeframe: tf },
      operator: operatorOf(c), value: c.value ?? (c.rhs ? { indicator: c.rhs.ind, args: c.rhs.params } : null),
      trigger: isInd
        ? { timeframe: tf, bar: "last_closed", evaluate_at: defaults.evaluate_at, recheck_at: defaults.entry_recheck, lookback_bars: c.within_bars ?? 1 }
        : { timeframe: null, bar: "latest", evaluate_at: "latest_close", recheck_at: null, lookback_bars: 1 },
      provenance: {
        "parameter.name": "stated",
        "parameter.args": argPaths.length ? worst(argPaths) : "n/a",
        "parameter.source": hasSource ? worst([`${base}params.source`]) : "n/a",
        "parameter.timeframe": isInd ? worst([`${base}tf`]) : "n/a",
        operator: worst([`${base}op`]),
        value: eventOp ? "n/a" : "stated",
        trigger: "assumed",   // a prompt never states when a rule is evaluated; it comes from the saved defaults
      },
      evaluable, not_evaluable_reason: reason,
    };
  };
  const live = program.conditions.map((c) => build(c, true, null));
  const dead = (program.not_evaluable ?? []).filter((n) => n.condition).map((n) => build(n.condition, false, n.reason));
  return [...live, ...dead].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
}

export function resolvedJson(program: ScreenProgram, defaults: UserDefaults) {
  return {
    defaults, universe: program.universe, conditions: toSlotConditions(program, defaults),
    sets: program.sets, actions: program.actions, assumptions: program.assumptions ?? [], not_evaluable: program.not_evaluable ?? [],
    timeframe_names: TF_NAME,
  };
}
