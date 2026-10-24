// Wording for the "Refresh data" control: when the weekly price cache was fetched, how old that is, and whether the
// newest bar is a week still in progress. Pure (the clock is passed in).
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const STALE_AFTER_HOURS = 12;   // the engine's own cache TTL

export function ageOf(fetchedAtIso: string | null | undefined, nowMs: number): { hours: number; label: string; stale: boolean } | null {
  if (!fetchedAtIso) return null;
  const t = Date.parse(fetchedAtIso);
  if (!Number.isFinite(t)) return null;
  const hours = Math.max(0, (nowMs - t) / 3_600_000);
  const label = hours < 1 ? `${Math.max(1, Math.round(hours * 60))} min ago` : hours < 48 ? `${Math.round(hours)} h ago` : `${Math.round(hours / 24)} days ago`;
  return { hours, label, stale: hours > STALE_AFTER_HOURS };
}

/** "15 Oct, 11:39" in the viewer's time zone. */
export function whenLabel(iso: string | null | undefined): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Weekly bars are dated by their Monday. The week is still in progress until that week's Friday has passed. */
export function barInProgress(latestBarDate: string | null | undefined, nowMs: number): boolean {
  if (!latestBarDate) return false;
  const monday = Date.parse(`${latestBarDate}T00:00:00Z`);
  if (!Number.isFinite(monday)) return false;
  const afterFriday = monday + 5 * 86_400_000;   // Saturday 00:00 UTC
  return nowMs < afterFriday;
}

export function barLabel(latestBarDate: string): string {
  const d = new Date(`${latestBarDate}T00:00:00Z`);
  return `week of ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
