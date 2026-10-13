// The plain-English reading of a program (plan §3.2). Built from templates, never by a model, so it says
// exactly what will run; the critic and the interpretation view both read this text.
import type { ScreenProgram } from "spec";
import { INDICATORS } from "./registry";

const TF: Record<string, string> = { "1D": "daily", "1W": "weekly", "1M": "monthly" };
const q = (v: unknown) => (v === null || v === undefined ? "?" : typeof v === "number" && Math.abs(v) >= 1000 ? v.toLocaleString("en-IN") : String(v));

const OUTPUT: Record<string, string> = {
  signal: "signal line", hist: "histogram", upper: "upper band", lower: "lower band", tenkan: "Tenkan-sen (conversion line)",
  kijun: "Kijun-sen (base line)", span_a: "cloud span A", span_b: "cloud span B", cloud_top: "top of the cloud", cloud_bottom: "bottom of the cloud",
  plus_di: "+DI", minus_di: "-DI", bandwidth: "bandwidth", stop_line: "stop line",
};

function operand(o: any): string {
  if (!o) return "?";
  if ("field" in o) return ({ mcap_cr: "market cap", traded_value_cr: "traded value", price: "price", volume: "volume", sector: "sector", rs_rating: "RS rating" } as Record<string, string>)[o.field] ?? o.field;
  if (o.ind === "bar") return `the ${o.params?.source ?? "close"}`;
  const reg = INDICATORS[o.ind];
  const args = (reg?.positional_params ?? []).map((n) => q(o.params?.[n])).join(", ");
  const src = o.params?.source ? `, ${o.params.source}` : "";
  const out = o.output && o.output !== "value" ? ` ${OUTPUT[o.output] ?? o.output}` : "";
  return `${reg?.label ?? o.ind}(${args}${src})${out}`;
}

function condition(c: ScreenProgram["conditions"][number]): string {
  const l = operand(c.lhs);
  const within = c.within_bars && c.within_bars > 1 ? ` within the last ${c.within_bars} bars` : "";
  const other = () => (c.rhs ? operand(c.rhs) : q(c.value));
  const times = c.rhs_mult !== undefined && c.rhs_mult !== 1 ? ` × ${q(Math.round(c.rhs_mult * 10000) / 10000)}` : "";
  switch (c.op) {
    case "up_over": return `${l} is higher than it was ${c.bars ?? "?"} bars ago`;
    case "down_over": return `${l} is lower than it was ${c.bars ?? "?"} bars ago`;
    case "flip": return `${l} flipped ${c.dir === "short" ? "short (bearish)" : "long (bullish)"}${within}`;
    case "cross_above": return `${l} crossed above ${other()}${within}`;
    case "cross_below": return `${l} crossed below ${other()}${within}`;
    case "cross_any": return `${l} crossed ${other()} in either direction (bullish or bearish)${within}`;
    case "between": { const v = c.value as unknown[]; return `${l} is between ${q(v?.[0])} and ${q(v?.[1])}${"field" in c.lhs && c.lhs.field === "mcap_cr" ? " crore" : ""}`; }
    case "outside": { const v = c.value as unknown[]; return `${l} is outside ${q(v?.[0])} to ${q(v?.[1])}`; }
    case null: return `${l} (comparison unclear)`;
    default: return `${l} ${({ ">": "is above", ">=": "is at least", "<": "is below", "<=": "is at most", "==": "equals" } as Record<string, string>)[c.op] ?? c.op} ${other()}${times}`;
  }
}

export function renderEnglish(p: ScreenProgram): string {
  const u = p.universe.source === "index" ? `**${p.universe.index}** stocks` : "**all NSE** stocks";
  const tfs = [...new Set(p.conditions.map((c) => (c.lhs as any).tf).filter(Boolean))] as string[];
  const on = tfs.length ? `, on **${tfs.map((t) => TF[t]).join(" and ")}** candles` : "";
  const conds = p.conditions.map(condition);
  const parts = [`From ${u}${on}, find stocks where ${conds.length ? conds.map((c) => `**${c}**`).join(", and ") : "nothing is tested yet"}.`];
  for (const a of p.actions as any[]) {
    if (a.type === "rank") parts.push(`Rank them by **${a.by?.[0]?.key?.endsWith("event_date") ? "event (crossover/flip) date" : a.by?.[0]?.key?.endsWith(".value") ? "the condition's value" : a.by?.[0]?.key ?? "?"}**, ${a.by?.[0]?.order === "asc" ? "oldest" : "newest"} first.`);
    else if (a.type === "limit") parts.push(`Keep the top **${a.n}**.`);
    else if (a.type === "group_by") {
      const h = a.highlight;
      const how = h?.metric === "ew_sector_return_vs_universe" ? ` and highlight sectors whose equal-weight ${h.lookback_sessions}-session return beats the whole universe${h.top_n_per_group ? `, listing each one's top ${h.top_n_per_group} stocks` : ""}` : h ? " and highlight outperforming sectors" : "";
      parts.push(`Group them by **sector**${how}.`);
    } else if (a.type === "trade_plan") {
      const atr = a.stop?.from_atr;
      const stop = atr ? ` with a stop ${atr.mult} × ATR(${atr.length}) below entry` : a.stop ? " with a stop loss" : "";
      const target = a.target?.r_multiple ? ` and a target of ${a.target.r_multiple}R` : "";
      parts.push(`Build a trade plan${stop}${a.entry ? `, entering at the ${a.entry.at === "next_open" ? "next open" : "entry price"}` : ""}${target}${a.confidence ? " and a confidence score" : ""}.`);
    }
    else if (a.type === "validate") parts.push(`Validate by re-running ${a.shift?.weeks ? Math.abs(a.shift.weeks) + " week back" : "on earlier data"} and measuring ${a.horizons_w ? a.horizons_w.join("/") + "-week" : "forward"} returns.`);
  }
  return parts.join(" ");
}
