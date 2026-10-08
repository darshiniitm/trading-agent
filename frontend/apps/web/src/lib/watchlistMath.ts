// Pure helpers behind the watchlist screen: formatting, "since entry", and the KPI row. No dates or weekdays are
// hard-coded — every date shown comes from the data.

export type EntryLike = { entryId: number; symbol: string; membership: string; status: string; entryPrice: number | null; refPrice: number | null };
export type QuoteLike = { price: number | null; asOf: string | null; error: string | null; chgPct?: number };

const MINUS = "−";

export function fmtSignedPct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${n < 0 ? MINUS : "+"}${Math.abs(n).toFixed(digits)}%`;
}

export function fmtPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function fmtDate(iso: string | null | undefined, withWeekday = false): string {
  if (!iso) return "—";
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${withWeekday ? `${WEEKDAYS[d.getUTCDay()]} ` : ""}${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Entered picks measure against their entry; shadow rows against the reference price (flagged "ref" in the UI).
export function sinceEntry(e: EntryLike, quote: QuoteLike | undefined): { pct: number; ref: boolean } | null {
  if (!quote || quote.price === null) return null;
  if (e.status === "entered" && e.entryPrice) return { pct: ((quote.price - e.entryPrice) / e.entryPrice) * 100, ref: false };
  if (e.membership !== "full_match" && e.refPrice) return { pct: ((quote.price - e.refPrice) / e.refPrice) * 100, ref: true };
  return null;
}

export function newestAsOf(quotes: Record<string, QuoteLike>): string | null {
  const all = Object.values(quotes).map((q) => q.asOf).filter((a): a is string => !!a).sort();
  return all.length ? all[all.length - 1] : null;
}

export function computeKpis(entries: EntryLike[], quotes: Record<string, QuoteLike>, hasNearMiss: boolean) {
  const picks = entries.filter((e) => e.membership === "full_match");
  const entered = picks.filter((e) => e.status === "entered");
  const pending = picks.filter((e) => e.status === "pending_selection");
  const parts = [
    entered.length ? `${entered.length} entered` : null,
    pending.length ? `${pending.length} pending` : null,
    picks.filter((e) => e.status === "not_confirmed").length ? `${picks.filter((e) => e.status === "not_confirmed").length} not confirmed` : null,
  ].filter(Boolean);
  const returns = entered.map((e) => sinceEntry(e, quotes[e.symbol])).filter((r): r is { pct: number; ref: boolean } => r !== null);
  const avg = returns.length ? returns.reduce((a, r) => a + r.pct, 0) / returns.length : null;
  return {
    picks: { value: picks.length, note: parts.join(" · ") },
    avgSinceEntry: { value: avg, n: returns.length },
    // U2: shadow count only if near-miss rows exist; otherwise the slot reports stocks with missing data.
    third: hasNearMiss
      ? { label: "Shadow on watchlist", value: entries.filter((e) => e.membership === "near_miss").length, note: "not graded" }
      : { label: "Unevaluated", value: entries.filter((e) => e.status === "no_point_data").length, note: "stocks with missing data" },
  };
}
