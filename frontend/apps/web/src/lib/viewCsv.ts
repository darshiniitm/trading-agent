import { fmtDate } from "@/lib/watchlistMath";
import type { Col, ColCtx, ViewRow, ViewSection } from "@/components/watchlist/viewTypes";

const q = (c: unknown) => `"${String(c).replace(/"/g, '""')}"`;

/** CSV of the current view: visible columns only, a Section column, and the as-of lines above the header row. */
export function buildViewCsv(o: {
  view: string; sections: ViewSection[]; cols: Col[]; ctx: ColCtx; query?: string;
  asOf: { quotes: string | null; fundamentals: string | null; metrics: string | null; fx: string | null };
}): string {
  const needle = (o.query ?? "").trim().toLowerCase();
  const keep = (r: ViewRow) => !needle || r.symbol.toLowerCase().includes(needle) || (r.name ?? "").toLowerCase().includes(needle);
  const lines: string[] = [
    `# View: ${o.view} · Prices as of ${o.asOf.quotes ?? "not fetched"} (Yahoo Finance, may be delayed)`,
    `# Fundamentals as of ${o.asOf.fundamentals ? fmtDate(o.asOf.fundamentals) : "not fetched"} · Metrics as of last close ${o.asOf.metrics ? fmtDate(o.asOf.metrics) : "not computed"}`,
    ...(o.ctx.ccy === "USD" ? [`# Money columns in USD (FX as of ${o.asOf.fx ?? "unknown"}); percentages, ratios and index points unchanged`] : []),
    ["Section", "Symbol", "Name", ...o.cols.map((c) => c.label)].map(q).join(","),
  ];
  for (const s of o.sections) {
    for (const r of s.rows.filter(keep)) {
      lines.push([s.label, r.symbol, r.name ?? "", ...o.cols.map((c) => { const cell = c.get(r, o.ctx); return cell.icon ? `${cell.icon} ${cell.text}` : cell.text; })].map(q).join(","));
    }
  }
  return lines.join("\n");
}
