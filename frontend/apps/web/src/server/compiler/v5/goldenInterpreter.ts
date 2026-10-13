// The interpreter golden set (plan §8.1): procedural / plain-English prompts and the program each must
// become. `needsModel` cases are worded so the tools cannot read them; they measure the Reader.
// One source for the unit tests (tools-only cases must be 100%) and the model comparison (P5).
import type { ScreenProgram } from "spec";
import { toFiveSlots } from "./slots5";

export type Expected = {
  universe: { source: "nse_all" | "index"; index?: string };
  cond: { lhs: string; rhs: string; op: string; tf: string };
  rank?: { key: string; order: "asc" | "desc" };
};
export type InterpreterCase = { id: string; text: string; expected: Expected; needsModel: boolean };

const UNIVERSES: [string, Expected["universe"]][] = [
  ["Nifty 100", { source: "index", index: "NIFTY 100" }], ["Nifty 50", { source: "index", index: "NIFTY 50" }], ["Nifty 200", { source: "index", index: "NIFTY 200" }],
  ["Nifty 500", { source: "index", index: "NIFTY 500" }], ["Nifty Midcap 150", { source: "index", index: "NIFTY MIDCAP 150" }],
];
const PAIRS: [string, number, string, number][] = [["SMA", 6, "SMA", 30], ["SMA", 20, "SMA", 50], ["SMA", 50, "SMA", 200], ["EMA", 9, "EMA", 21], ["EMA", 12, "EMA", 26], ["SMA", 10, "EMA", 30]];
const TITLES = (u: string, ind: string) => [`Build a ${u} ${ind} crossover scanner:`, `Create a ${u} ${ind} crossover screener`, `${u} stocks`, `Scan the ${u} for ${ind} crossovers`, `${u} stocks from the official Nifty Indices CSV`];
const COMPUTE = (a: string, x: number, b: string, y: number) => [`Calculate ${a} ${x} and ${b} ${y}`, `Compute ${a}(${x}) and ${b}(${y})`, `Calculate the ${a} ${x} and the ${b} ${y}`, `Find ${a} ${x} and ${b} ${y}`];
const DETECT: [string, string][] = [["Detect bullish and bearish crossovers", "cross_any"], ["Find bullish and bearish crossovers", "cross_any"], ["Detect crossovers", "cross_any"],
  ["Detect bullish crossovers", "cross_above"], ["Detect bearish crossovers", "cross_below"], ["Identify bullish crossovers within the last 3 days", "cross_above"]];
const TF: [string, string][] = [["Fetch daily historical candles", "1D"], ["Use daily candles", "1D"], ["On daily candles", "1D"], ["Fetch weekly candles", "1W"]];
const RANK: [string, Expected["rank"]][] = [["Rank stocks by the most recent crossover date first", { key: "event_date", order: "desc" }], ["Sort by latest crossover date", { key: "event_date", order: "desc" }],
  ["Rank by crossover date, oldest first", { key: "event_date", order: "asc" }]];

const tag = (ind: string, n: number) => `${ind.toLowerCase()}(length=${n})`;

export function buildGolden(): InterpreterCase[] {
  const out: InterpreterCase[] = [];
  const N = 48;
  for (let i = 0; i < N; i++) {
    const [uName, uExp] = UNIVERSES[i % UNIVERSES.length];
    const [a, x, b, y] = PAIRS[i % PAIRS.length];
    const title = TITLES(uName, a)[i % 5];
    const [detect, op] = DETECT[i % DETECT.length];
    const [tfLine, tf] = TF[i % TF.length];
    const [rankLine, rank] = RANK[i % RANK.length];
    const withLoad = i % 2 === 0;
    const lines = [title, ...(withLoad ? ["Load them"] : []), tfLine, COMPUTE(a, x, b, y)[i % 4], detect, rankLine];
    // a title that is only the universe would make an indicator-less "Nifty 500 stocks from the CSV" fine; the rest carry it
    out.push({ id: `proc-${String(i + 1).padStart(2, "0")}`, text: lines.join("\n"), needsModel: false,
      expected: { universe: uExp, cond: { lhs: tag(a, x), rhs: tag(b, y), op, tf }, rank } });
  }
  // wording the tools cannot read: the Reader has to link the lines
  const MODEL: [string, Expected][] = [
    ["Nifty 100 stocks\nUse daily candles\nTake the 6 day and 30 day simple averages of the close\nTell me when the faster one goes over the slower one\nRank by most recent crossover date first",
      { universe: { source: "index", index: "NIFTY 100" }, cond: { lhs: "sma(length=6)", rhs: "sma(length=30)", op: "cross_above", tf: "1D" }, rank: { key: "event_date", order: "desc" } }],
    ["Nifty 50 stocks\nOn daily candles\nTrack the 9 and 21 exponential averages\nAlert me when the short one falls under the long one",
      { universe: { source: "index", index: "NIFTY 50" }, cond: { lhs: "ema(length=9)", rhs: "ema(length=21)", op: "cross_below", tf: "1D" } }],
    ["Nifty 200 stocks\nDaily candles\nLook at the 20 day and the 50 day simple moving averages\nShow stocks where they have just crossed, either way",
      { universe: { source: "index", index: "NIFTY 200" }, cond: { lhs: "sma(length=20)", rhs: "sma(length=50)", op: "cross_any", tf: "1D" } }],
    ["Nifty 100 stocks\nDaily candles\nWhere the 50 day simple average moves above the 200 day simple average",
      { universe: { source: "index", index: "NIFTY 100" }, cond: { lhs: "sma(length=50)", rhs: "sma(length=200)", op: "cross_above", tf: "1D" } }],
    ["Nifty 500 stocks\nWeekly candles\nThe 10 week and 30 week simple averages, flag where the 10 goes below the 30",
      { universe: { source: "index", index: "NIFTY 500" }, cond: { lhs: "sma(length=10)", rhs: "sma(length=30)", op: "cross_below", tf: "1W" } }],
    ["Nifty Midcap 150 stocks\nDaily candles\nTwo exponential averages, 12 and 26\nI want the ones where the 12 overtakes the 26",
      { universe: { source: "index", index: "NIFTY MIDCAP 150" }, cond: { lhs: "ema(length=12)", rhs: "ema(length=26)", op: "cross_above", tf: "1D" } }],
  ];
  MODEL.forEach(([text, expected], i) => out.push({ id: `model-${i + 1}`, text, expected, needsModel: true }));
  return out;
}
export const GOLDEN_INTERPRETER = buildGolden();

const canon = (o: any) => ("ind" in o ? `${o.ind}(${Object.entries(o.params).filter(([k]) => k !== "source").map(([k, v]) => `${k}=${v ?? "?"}`).join(",")})` : o.field);

export const SLOT_NAMES = ["universe", "parameter", "value", "trigger", "data_range", "operator", "rank"] as const;
export type SlotName = (typeof SLOT_NAMES)[number];

// Per-slot exact-match of what the program became against what the case expects.
export function slotMatches(p: ScreenProgram, e: Expected): Record<SlotName, boolean> {
  const c = p.conditions[0] as any;
  const slots = toFiveSlots(p);
  const rank = (p.actions as any[]).find((a) => a.type === "rank");
  return {
    universe: p.universe.source === e.universe.source && (p.universe.index ?? undefined) === e.universe.index,
    parameter: !!c && canon(c.lhs) === e.cond.lhs,
    value: !!c && !!c.rhs && canon(c.rhs) === e.cond.rhs,
    trigger: !!c && slots.conditions[0]?.trigger.within_bars >= 1,
    data_range: !!c && c.lhs.tf === e.cond.tf,
    operator: !!c && c.op === e.cond.op,
    rank: e.rank ? !!rank && rank.by?.[0]?.key?.endsWith(e.rank.key) && rank.by[0].order === e.rank.order : true,
  };
}
export const casePasses = (m: Record<SlotName, boolean>) => SLOT_NAMES.every((s) => m[s]);

export function slotReport(rows: Record<SlotName, boolean>[]) {
  return Object.fromEntries(SLOT_NAMES.map((s) => [s, rows.length ? rows.filter((r) => r[s]).length / rows.length : 0])) as Record<SlotName, number>;
}
