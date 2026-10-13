// One-line wording for a rule, shared by the interpretation chips, watchlist flags, the detail panel and Explore cards.
export type Slot = {
  id: string; source_text: string; operator: string | null; value: unknown; evaluable: boolean; not_evaluable_reason: string | null;
  parameter: { name: string; args: Record<string, unknown>; source: string | null; timeframe: string | null };
  trigger: { evaluate_at: string };
};

const TF_WORD: Record<string, string> = { "1D": "daily", "1W": "weekly", "1M": "monthly" };
const FIELD_WORD: Record<string, string> = { mcap_cr: "Market cap (cr)", traded_value_cr: "Traded value (cr)", price: "Price", volume: "Volume", sector: "Sector" };
const OP_WORD: Record<string, string> = {
  "<": "<", "<=": "≤", ">": ">", ">=": "≥", "=": "=", between: "between", outside: "outside", flips_long: "flips long", flips_short: "flips short",
  crosses_above: "crosses above", crosses_below: "crosses below", crosses_any: "crosses", rising_n: "rising", falling_n: "falling",
};
const WHEN_WORD: Record<string, string> = { friday_close: "Friday close" };

// `RSI(14) · weekly · Friday close · between 50–65` — one line per rule, from the resolved 4-slot JSON.
export function ruleLine(c: Slot): string {
  const p = c.parameter;
  const args = Object.values(p.args).concat(p.source ? [p.source] : []).join(", ");
  const name = p.name.toUpperCase();
  const left = args ? `${name}(${args})` : FIELD_WORD[p.name] ?? p.name.replace(/_/g, " ");
  const v = Array.isArray(c.value) ? c.value.join("–") : c.value === null || c.value === undefined ? "" : typeof c.value === "object" ? "" : String(c.value);
  return [left, p.timeframe ? TF_WORD[p.timeframe] : null, p.timeframe ? WHEN_WORD[c.trigger.evaluate_at] ?? c.trigger.evaluate_at : null, `${OP_WORD[c.operator ?? ""] ?? c.operator ?? ""} ${v}`.trim()]
    .filter(Boolean).join(" · ");
}

// The same wording for a stored `prompt_conditions` row (flat name / params / op / value, no timeframe).
export function storedConditionLabel(c: { name: string; params?: Record<string, unknown> | null; op: string; value: unknown }): string {
  return ruleLine({
    id: "", source_text: "", operator: c.op, value: c.value, evaluable: true, not_evaluable_reason: null,
    parameter: { name: c.name, args: c.params ?? {}, source: null, timeframe: null }, trigger: { evaluate_at: "" },
  });
}
