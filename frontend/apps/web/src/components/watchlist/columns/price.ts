import { fmtCompact, fmtPctSigned, toneOf } from "@/lib/viewFormat";
import type { Col } from "../viewTypes";
import { dash, gate, money } from "./helpers";

export const priceColumns: Col[] = [
  { id: "last", label: "Last", tooltip: "Last traded price (Yahoo Finance, may be delayed). Indices show points.", align: "right", get: (r, c) => (r.price.last === null ? dash("No quote") : money(r.price.last, r, c)) },
  { id: "chgPct", label: "Chg %", tooltip: "Change vs the previous close.", align: "right", get: (r) => (r.price.chgPct === null ? dash() : { text: fmtPctSigned(r.price.chgPct), tone: toneOf(r.price.chgPct) }) },
  { id: "chg", label: "Chg", tooltip: "Absolute change vs the previous close.", align: "right", get: (r, c) => (r.price.chg === null ? dash() : money(r.price.chg, r, c, { signed: true })) },
  { id: "volume", label: "Volume", tooltip: "Today's session volume.", align: "right", get: (r) => gate(r, { indexNA: true }) ?? (r.price.volume === null ? dash() : { text: fmtCompact(r.price.volume, 2) }) },
  { id: "avgVol10", label: "Avg Vol (10)", tooltip: "Mean volume of the last 10 completed sessions.", align: "right", get: (r) => gate(r, { indexNA: true }) ?? (r.price.avgVol10 === null ? dash() : { text: fmtCompact(r.price.avgVol10, 2) }) },
  { id: "marketCap", label: "Market cap", tooltip: "Shares outstanding × last price; the fundamentals snapshot value until a newer quote arrives.", align: "right", get: (r, c) => gate(r, { indexNA: true }) ?? money(r.price.marketCap, r, c, { compact: true }) },
];
