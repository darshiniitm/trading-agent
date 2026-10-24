import { convertMoney, fmtCompact, fmtNum, fmtPctSigned, fmtSigned, toneOf } from "@/lib/viewFormat";
import type { Cell, ColCtx, ViewRow } from "../viewTypes";

export const NA_INDEX = "Not applicable to an index";
export const dash = (title?: string): Cell => ({ text: "—", tone: "muted", title });
/** Cell for a value that does not exist for an index row, or is still being computed. */
export const gate = (row: ViewRow, { indexNA = false } = {}): Cell | null =>
  indexNA && row.kind === "index" ? dash(NA_INDEX) : row.computing ? dash("Computing…") : null;

export function money(n: number | null, row: ViewRow, ctx: ColCtx, o: { compact?: boolean; digits?: number; signed?: boolean; indexNA?: boolean } = {}): Cell {
  const g = o.indexNA && row.kind === "index" ? dash(NA_INDEX) : null;
  if (g) return g;
  if (n === null) return dash();
  if (row.kind === "index") {   // index points are never currency-converted
    return { text: `${o.signed ? fmtSigned(n, o.digits ?? 2) : fmtNum(n, o.digits ?? 2)} POINT`, tone: o.signed ? toneOf(n) : undefined };
  }
  const { value, unit } = convertMoney(n, row.price.currency, ctx.ccy, ctx.usdPerInr);
  if (value === null) return dash("FX rate unavailable");
  const body = o.compact ? fmtCompact(value, 2) : o.signed ? fmtSigned(value, o.digits ?? 2) : fmtNum(value, o.digits ?? 2);
  return { text: `${body} ${unit}`, tone: o.signed ? toneOf(value) : undefined };
}

export const pct = (n: number | null): Cell => (n === null ? dash() : { text: fmtPctSigned(n), tone: toneOf(n) });
