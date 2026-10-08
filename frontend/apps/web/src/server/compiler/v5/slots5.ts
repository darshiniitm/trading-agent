// The five-slot view of a program (plan §1): parameter, condition value, trigger point, data range,
// operator/rank — each with where it came from. Derived from the program, its source phrases and its
// assumptions, so it can never disagree with what runs. Knowledge-repository common values are attached to
// an assumed or missing parameter as one-tap suggestions only; they are never filled in.
import type { ScreenProgram } from "spec";
import { kbEntry, warmupBars, type IndicatorKb } from "spec/src/kb";

export type SlotStatus = "from_prompt" | "derived" | "assumed" | "missing";
export type ParamState = { name: string; value: unknown; status: SlotStatus; suggestions: (number | string)[] };
export type FiveSlots = {
  id: string; text: string; evaluable: boolean;
  parameter: { status: SlotStatus; label: string; params: ParamState[] };
  value: { status: SlotStatus; label: string };
  trigger: { status: SlotStatus; label: string; within_bars: number };
  data_range: { status: SlotStatus; label: string; timeframe: string | null; min_bars: number | null };
  operator: { status: SlotStatus; label: string };
};
export type RankSlot = { action: string; key: string | null; order: string | null; limit: number | null; status: SlotStatus };

const EVENTS = ["flip", "cross_above", "cross_below", "cross_any", "rising", "falling"];
const worst = (xs: SlotStatus[]): SlotStatus => (["missing", "assumed", "derived"] as SlotStatus[]).find((s) => xs.includes(s)) ?? "from_prompt";

export function toFiveSlots(p: ScreenProgram): { conditions: FiveSlots[]; rank: RankSlot[] } {
  const assumed = new Map((p.assumptions ?? []).map((a) => [a.path, a.provenance]));
  const stated = new Set(p.source_phrases.map((s) => s.path));
  const build = (c: any, evaluable: boolean): FiveSlots => {
    const base = `conditions.${c.id}.`;
    const operands: [string, any][] = [["", c.lhs], ["rhs.", c.rhs]].filter(([, o]) => o) as any;
    const params: ParamState[] = [];
    const labels: string[] = [];
    let minBars: number | null = 0;
    for (const [prefix, o] of operands) {
      if (!("ind" in o)) { labels.push(o.field); continue; }
      const kb = kbEntry(o.ind, "indicator") as IndicatorKb | undefined;
      const inner = Object.entries(o.params ?? {}).map(([name, value]) => {
        const path = `${base}${prefix}params.${name}`;
        const a = assumed.get(path);
        const status: SlotStatus = a ? (a === "inferred" ? "derived" : "assumed") : value === null || value === undefined ? "missing" : "from_prompt";
        const sugg = status === "from_prompt" ? [] : kb?.params.find((x) => x.name === name)?.common_values ?? [];
        return { name: prefix ? `rhs.${name}` : name, value, status, suggestions: sugg };
      });
      params.push(...inner);
      labels.push(`${kb?.label ?? o.ind}(${inner.filter((x) => x.name !== "source" && x.name !== "rhs.source").map((x) => x.value ?? "?").join(", ")})`);
      const bars = kb ? warmupBars(kb, o.params) : null;
      minBars = minBars === null || bars === null ? null : Math.max(minBars, bars);
    }
    const isInd = "ind" in c.lhs;
    const tf: string | null = isInd ? c.lhs.tf : null;
    const tfPath = `${base}tf`;
    const tfStatus: SlotStatus = !isInd ? "derived" : assumed.has(tfPath) ? (assumed.get(tfPath) === "inferred" ? "derived" : "assumed") : tf ? "from_prompt" : "missing";
    const within = c.within_bars ?? 1;
    const event = EVENTS.includes(c.op ?? "");
    const opStatus: SlotStatus = assumed.has(`${base}op`) ? "assumed" : c.op === null ? "missing" : event ? "derived" : "from_prompt";
    const valueLabel = event ? (c.rhs ? `the other series (${labels[1] ?? "?"})` : "none — an event") : Array.isArray(c.value) ? `${c.value.join(" to ")}` : String(c.value ?? "?");
    return {
      id: c.id, text: c.phrase ?? "", evaluable,
      parameter: { status: params.length ? worst(params.map((x) => x.status)) : "from_prompt", label: labels[0] ?? "?", params },
      value: { status: event ? "derived" : c.value === undefined || c.value === null ? "missing" : stated.has(`${base}value`) || stated.has(`${base}value.0`) ? "from_prompt" : "derived", label: valueLabel },
      trigger: { status: stated.has(`${base}within_bars`) ? "from_prompt" : "derived", within_bars: within,
        label: `last completed ${tf ? ({ "1D": "daily", "1W": "weekly", "1M": "monthly" } as Record<string, string>)[tf] : ""} bar${event ? `, event within ${within} bar${within === 1 ? "" : "s"}` : ""}`.replace("  ", " ") },
      data_range: { status: tfStatus, timeframe: tf, min_bars: minBars === null ? null : minBars + (event ? within : 0),
        label: `${tf ?? "timeframe ?"}${minBars === null ? "" : `, at least ${minBars + (event ? within : 0)} bars of history`}` },
      operator: { status: opStatus, label: c.op ?? "?" },
    };
  };
  const live = p.conditions.map((c) => build(c, true));
  const dead = (p.not_evaluable ?? []).filter((n) => n.condition).map((n) => build(n.condition, false));
  const rank: RankSlot[] = (p.actions as any[]).filter((a) => a.type === "rank" || a.type === "limit").map((a) => ({
    action: a.id, key: a.by?.[0]?.key ?? null, order: a.by?.[0]?.order ?? null, limit: a.n ?? null,
    status: assumed.has(`actions.${a.id}.by`) ? "assumed" : a.by?.length || a.n ? "from_prompt" : "missing",
  }));
  return { conditions: [...live, ...dead].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1))), rank };
}
