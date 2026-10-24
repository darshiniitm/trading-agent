import { fmtNum, fmtPctPlain } from "@/lib/viewFormat";
import type { Col } from "../viewTypes";
import { dash, gate, money } from "./helpers";

export const financialsColumns: Col[] = [
  { id: "revenue", label: "Revenue (TTM)", tooltip: "Total revenue, sum of the last 4 quarters (last fiscal year if quarters are unavailable).", align: "right", get: (r, c) => gate(r, { indexNA: true }) ?? money(r.financials.revenue, r, c, { compact: true }) },
  { id: "eps", label: "EPS (TTM)", tooltip: "Diluted earnings per share, trailing 12 months.", align: "right", get: (r, c) => gate(r, { indexNA: true }) ?? money(r.financials.eps, r, c) },
  { id: "pe", label: "P/E", tooltip: "Last price ÷ EPS (TTM). Blank when EPS is zero or negative.", align: "right", get: (r) => gate(r, { indexNA: true }) ?? (r.financials.pe === null ? dash("Blank when EPS ≤ 0 or no price") : { text: fmtNum(r.financials.pe, 2) }) },
  { id: "beta", label: "Beta", tooltip: "Beta 1Y against NIFTY 50 (NSE symbols) or S&P 500 (US).", align: "right", get: (r) => gate(r, { indexNA: true }) ?? (r.financials.beta === null ? dash() : { text: fmtNum(r.financials.beta, 2) }) },
  { id: "dividend", label: "Dividend (TTM)", tooltip: "Dividends per share paid in the last 12 months.", align: "right", get: (r, c) => gate(r, { indexNA: true }) ?? money(r.financials.dividend, r, c) },
  { id: "yield", label: "Yield", tooltip: "Dividend (TTM) ÷ last price.", align: "right", get: (r) => gate(r, { indexNA: true }) ?? (r.financials.yield === null ? dash() : { text: fmtPctPlain(r.financials.yield, 2) }) },
];
