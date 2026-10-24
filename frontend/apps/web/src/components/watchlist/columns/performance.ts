import { fmtDate } from "@/lib/watchlistMath";
import type { Col, ViewRow } from "../viewTypes";
import { gate, pct } from "./helpers";

const col = (id: keyof ViewRow["performance"], label: string, tooltip: string): Col => ({
  id, label, tooltip, align: "right", get: (r) => gate(r) ?? pct(r.performance[id] as number | null),
});

export const performanceColumns: Col[] = [
  col("w1", "Perf % 1W", "Change vs the last close on or before 7 days ago (split/dividend-adjusted closes)."),
  col("m1", "Perf % 1M", "Change vs the last close on or before 1 calendar month ago."),
  col("m3", "Perf % 3M", "Change vs the last close on or before 3 calendar months ago."),
  col("ytd", "Perf % YTD", "Change vs the last close of the previous calendar year."),
  col("y1", "Perf % 1Y", "Change vs the last close on or before 1 year ago."),
  col("y5", "Perf % 5Y", "Change vs the last close on or before 5 years ago."),
  { ...col("all", "Perf % All time", "Change vs the first close Yahoo has. Yahoo's history depth differs from TradingView's, so this will not match exactly."),
    get: (r) => gate(r) ?? { ...pct(r.performance.all), title: r.performance.firstCloseDate ? `Since the first available close, ${fmtDate(r.performance.firstCloseDate)} ${r.performance.firstCloseDate.slice(0, 4)}` : undefined } },
];
