import type { Currency } from "@/lib/viewFormat";

// Shape of GET /api/watchlists/:id/views (src/server/views.ts). Display only.
export type ViewId = "screen" | "price" | "financials" | "performance" | "risk" | "technicals";
export type Tf = "1D" | "1W";
export type ViewRow = {
  symbol: string; kind: "stock" | "index"; name: string | null; computing: boolean;
  entryId?: number; status?: string; membership?: string;
  price: { last: number | null; chg: number | null; chgPct: number | null; volume: number | null; avgVol10: number | null; marketCap: number | null; currency: string | null; unit: string | null };
  financials: { revenue: number | null; eps: number | null; pe: number | null; beta: number | null; dividend: number | null; yield: number | null };
  performance: { w1: number | null; m1: number | null; m3: number | null; ytd: number | null; y1: number | null; y5: number | null; all: number | null; firstCloseDate: string | null };
  risk: { beta1y: number | null; beta3y: number | null; beta5y: number | null; benchmark: string | null; vol1d: number | null; vol1w: number | null; vol1m: number | null };
  technicals: { timeframe: Tf; rsi: number | null; mom: number | null; ao: number | null; cci: number | null; techRating: number | null; maRating: number | null; osRating: number | null; techLabel: string | null; maLabel: string | null; osLabel: string | null; votes: unknown };
};
export type ViewSection = { id: "benchmarks" | "picks" | "watching" | "dropped"; label: string; rows: ViewRow[]; collapsedByDefault: boolean; pinned?: boolean };
export type ViewPrefs = { view: ViewId; hiddenColumns: Record<string, string[]>; currency: Currency; techTimeframe: Tf; compact: boolean };
export type Fx = { inrPerUsd: number; usdPerInr: number; asOf: string | null };
export type ViewsPayload = {
  tf: Tf; sections: ViewSection[]; fx: Fx | null; prefs: ViewPrefs; missingSymbols: string[];
  asOf: { quotes: string | null; fundamentals: string | null; metrics: string | null; fx: string | null };
};

export type Cell = { text: string; tone?: "pos" | "neg" | "muted"; title?: string; icon?: string };
export type ColCtx = { ccy: Currency; usdPerInr: number | null };
export type Col = { id: string; label: string; tooltip: string; align: "left" | "right"; get: (row: ViewRow, ctx: ColCtx) => Cell };
