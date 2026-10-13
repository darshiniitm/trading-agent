// Step 6 — every question is templated from the path, the reason and registry metadata. The model
// never writes one, and options are only ever built from the user's own words/numbers or the
// engine's own catalog of choices — never a suggested value (D6).
import type { NeedsInputV5, ScreenProgram } from "spec";
import { FIELDS, INDICATORS, indLabel, paramMeta } from "./registry";

export const ENTRY_OPTIONS = [
  { label: "at the signal week's closing price", value: "signal_close" },
  { label: "at the next week's open", value: "next_open" },
];
export const CONFIDENCE_OPTIONS = [
  { label: "number of conditions met", value: "conditions_met_count" },
  { label: "RSI position in its band and closeness of the stop", value: "rsi_band_and_stop_distance" },
  { label: "historical hit rate of the same setup over the last N weeks", value: "historical_hit_rate" },
];
export const METRIC_OPTIONS = [
  { label: "sector's return vs the benchmark index", value: "sector_return_vs_benchmark" },
  { label: "sector's share of qualifiers vs its share of the universe", value: "share_of_qualifiers_vs_universe" },
  { label: "median return of the sector's qualifiers", value: "median_return_of_qualifiers" },
];
export const TF_OPTIONS = [{ label: "daily", value: "1D" }, { label: "weekly", value: "1W" }, { label: "monthly", value: "1M" }];

const cond = (p: ScreenProgram, id: string) => p.conditions.find((c) => c.id === id);
const condLabel = (p: ScreenProgram, id: string) => {
  const c = cond(p, id);
  if (!c) return id;
  const o: any = c.lhs;
  return "ind" in o ? indLabel(o.ind) : FIELDS[o.field]?.label ?? o.field;
};
const opWords: Record<string, string> = { ">": "greater than", ">=": "at least", "<": "less than", "<=": "at most" };

export function optionsFor(path: string, program: ScreenProgram): { label: string; value: unknown }[] | undefined {
  if (/^actions\.A\d+\.entry\.at$/.test(path)) return ENTRY_OPTIONS;
  if (/^actions\.A\d+\.confidence\.method$/.test(path)) return CONFIDENCE_OPTIONS;
  if (/^actions\.A\d+\.highlight\.metric$/.test(path)) return METRIC_OPTIONS;
  if (/^conditions\.C\d+\.tf$/.test(path)) return TF_OPTIONS;
  const src = /^conditions\.C\d+\.(?:rhs\.)?params\.source$/.exec(path);
  if (src) return ["open", "high", "low", "close"].map((v) => ({ label: v, value: v }));
  void program;
  return undefined;
}

export function questionFor(n: NeedsInputV5, program: ScreenProgram): string {
  const m = /^conditions\.(C\d+)\.(.+)$/.exec(n.path);
  if (n.reason === "contradiction") {
    const labels = (n.options ?? []).map((o) => o.label);
    return `"${n.phrase}" — did you mean ${labels.length > 1 ? `${labels.slice(0, -1).join(", ")}, or ${labels.at(-1)}` : labels[0]}?`;
  }
  if (n.reason === "ambiguous") {
    const opts = (n.options ?? []).map((o, i) => `(${String.fromCharCode(97 + i)}) ${o.label}`).join(", ");
    return `"${n.phrase ?? ""}" could mean: ${opts}. Which one?`;
  }
  if (n.reason === "placeholder" && m) {
    const what = /value\.0$/.test(m[2]) ? `the lower bound of the ${condLabel(program, m[1])} range`
      : /value\.1$/.test(m[2]) ? `the upper bound of the ${condLabel(program, m[1])} range`
      : (() => { const pm = /params\.(\w+)$/.exec(m[2]); return pm ? `the ${paramLabel(program, m[1], m[2], pm[1])} for ${condLabel(program, m[1])}` : "this value"; })();
    return `You wrote "${n.token}". What is ${what}?`;
  }
  if (m) {
    const [, id, rest] = m;
    const pm = /^(?:rhs\.)?params\.(\w+)$/.exec(rest);
    if (pm) {
      if (pm[1] === "window") return `What window (e.g. a number of weeks) should ${condLabel(program, id)} use?`;
      return `What ${paramLabel(program, id, rest, pm[1])} should ${condLabel(program, id)} use?`;
    }
    if (rest === "tf") return `Which timeframe should ${condLabel(program, id)} use — daily, weekly or monthly?`;
    if (rest === "rhs") return `What should ${condLabel(program, id)} be compared against?`;
    if (/^value(\.\d)?$/.test(rest)) {
      const c = cond(program, id);
      const side = rest === "value.0" ? "lower bound" : rest === "value.1" ? "upper bound" : null;
      return side ? `What is the ${side} of the ${condLabel(program, id)} range?`
        : `What value should ${condLabel(program, id)} be ${opWords[c?.op ?? ""] ?? "compared with"}?`;
    }
  }
  if (n.path === "universe.source") return "Which stocks should this screen start from — all NSE stocks, an index, or a list of symbols?";
  if (/\.entry\.at$/.test(n.path)) return "Where should the entry price (EP) be taken?";
  if (/\.confidence\.method$/.test(n.path)) return "How should the trade's confidence be calculated?";
  if (/\.confidence\.n_weeks$/.test(n.path)) return "Over how many past weeks should the hit rate be measured?";
  if (/\.highlight\.metric$/.test(n.path)) return "How should an outperforming sector be measured?";
  if (/\.highlight\.lookback_weeks$/.test(n.path)) return "Over how many weeks should sector performance be measured?";
  if (/\.highlight\.rule\.rs_gt$/.test(n.path)) return "How much must a sector beat the benchmark by (in return, as a decimal — e.g. 0.01 = 1%)?";
  if (/\.highlight\.rule\.top_k$/.test(n.path)) return "How many top sectors should be highlighted?";
  if (/\.highlight\.rule\.gt$/.test(n.path)) return "A sector is outperforming when its share of qualifiers is more than this multiple of its share of the universe — what multiple?";
  if (/\.stop\.from$/.test(n.path)) return "Which condition should supply the stop loss?";
  if (/\.shift\.weeks$/.test(n.path)) return "How many weeks back should the strategy be re-run (as a negative number, e.g. -1)?";
  if (/\.horizons_w$/.test(n.path)) return "Over how many weeks after each selection should returns be measured?";
  if (/\.by$/.test(n.path)) return "What should the ranking be based on?";
  if (/\.set$/.test(n.path)) return `Which stocks does "${n.phrase ?? "this step"}" refer to?`;
  return `What value should be used for ${n.path}?`;
}

function paramLabel(program: ScreenProgram, id: string, rest: string, name: string): string {
  const c = cond(program, id);
  const o: any = rest.startsWith("rhs.") ? c?.rhs : c?.lhs;
  return (o && "ind" in o ? paramMeta(o.ind, name)?.label : undefined) ?? name.replace(/_/g, " ");
}
void INDICATORS;
