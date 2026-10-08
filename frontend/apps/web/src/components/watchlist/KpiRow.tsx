import { Kpi } from "@/ui/Kpi";
import { computeKpis, fmtDate, addDays, fmtSignedPct, type EntryLike, type QuoteLike } from "@/lib/watchlistMath";
import styles from "./watchlist.module.css";

export function KpiRow({ entries, quotes, hasNearMiss, lastRunAsOf, entryAt }: {
  entries: EntryLike[]; quotes: Record<string, QuoteLike>; hasNearMiss: boolean; lastRunAsOf: string | null; entryAt: string | null;
}) {
  const k = computeKpis(entries, quotes, hasNearMiss);
  const avg = k.avgSinceEntry.value;
  return (
    <div className={styles.kpis}>
      <Kpi label="Arm picks" value={k.picks.value} note={k.picks.note || "none yet"} />
      <Kpi label="Avg since entry" value={fmtSignedPct(avg)} tone={avg === null ? undefined : avg < 0 ? "negative" : "positive"} note={`Equal-weight, ${k.avgSinceEntry.n} entered pick${k.avgSinceEntry.n === 1 ? "" : "s"}`} />
      <Kpi label={k.third.label} value={k.third.value} note={k.third.note} />
      <Kpi label="Next selection" value={lastRunAsOf ? fmtDate(addDays(lastRunAsOf, 7), true) : "—"} note={entryAt ? `Entry: ${entryAt.replace(/_/g, " ")}` : "Next completed weekly bar"} />
    </div>
  );
}
