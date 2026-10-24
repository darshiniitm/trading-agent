import { fmtPctPlain } from "@/lib/viewFormat";
import { fmtNum } from "@/lib/viewFormat";
import type { Col, ViewRow } from "../viewTypes";
import { dash, gate } from "./helpers";

const beta = (id: "beta1y" | "beta3y" | "beta5y", label: string, years: string): Col => ({
  id, label, tooltip: `Beta over ${years}: daily returns vs NIFTY 50 (NSE symbols) or S&P 500 (US).`, align: "right",
  get: (r: ViewRow) => gate(r) ?? (r.risk[id] === null ? dash() : { text: fmtNum(r.risk[id], 2), title: r.risk.benchmark ? `vs ${r.risk.benchmark}` : undefined }),
});
const vol = (id: "vol1d" | "vol1w" | "vol1m", label: string, sessions: string): Col => ({
  id, label, tooltip: `Mean daily (High − Low) ÷ Low over the last ${sessions}.`, align: "right",
  get: (r: ViewRow) => gate(r) ?? (r.risk[id] === null ? dash() : { text: fmtPctPlain(r.risk[id], 2) }),
});

export const riskColumns: Col[] = [
  beta("beta1y", "Beta 1Y", "1 year"), beta("beta3y", "Beta 3Y", "3 years"), beta("beta5y", "Beta 5Y", "5 years"),
  vol("vol1d", "Volatility 1D", "session"), vol("vol1w", "Volatility 1W", "5 sessions"), vol("vol1m", "Volatility 1M", "21 sessions"),
];
