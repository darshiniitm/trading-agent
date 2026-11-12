import type { Col, ViewId } from "../viewTypes";
import { financialsColumns } from "./financials";
import { performanceColumns } from "./performance";
import { priceColumns } from "./price";
import { riskColumns } from "./risk";
import { technicalsColumns } from "./technicals";

export type DataView = Exclude<ViewId, "screen">;
export const COLUMNS: Record<DataView, Col[]> = { price: priceColumns, financials: financialsColumns, performance: performanceColumns, risk: riskColumns, technicals: technicalsColumns };
export const VIEW_LABELS: Record<ViewId, string> = { screen: "Screen", price: "Price", financials: "Financials", performance: "Performance", risk: "Risk", technicals: "Technicals" };
export const VIEW_ORDER: ViewId[] = ["screen", "price", "financials", "performance", "risk", "technicals"];

export function visibleColumns(view: DataView, hidden: Record<string, string[]> | undefined): Col[] {
  const off = new Set(hidden?.[view] ?? []);
  return COLUMNS[view].filter((c) => !off.has(c.id));
}
