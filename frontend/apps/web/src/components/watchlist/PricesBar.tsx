import { Button } from "@/ui/Button";
import { fmtDate } from "@/lib/watchlistMath";
import styles from "./watchlist.module.css";

// "Prices as of" is the newest quote's own timestamp — never the wall clock — so nothing implies live data.
export function PricesBar({ asOf, lastBarDate, onRefresh, fetching, status, error, extraLine }: {
  asOf: string | null; lastBarDate: string | null; onRefresh: () => void; fetching: boolean; status: string; error: string | null; extraLine?: string | null;
}) {
  const time = asOf ? asOf.slice(11, 16) : null;
  return (
    <div className={styles.pricesBar}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
      <span>Prices as of <strong>{time ?? "not yet fetched"}</strong> · Yahoo Finance · may be delayed{lastBarDate ? ` · last trade ${fmtDate(lastBarDate)}` : ""}</span>
      <Button size={36} onClick={onRefresh} disabled={fetching}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" /></svg>
        Refresh prices
      </Button>
      <span aria-live="polite" className={styles.liveRegion}>{status}</span>
      {error && <span role="alert" className={styles.err}>{error}</span>}
      {extraLine && <span className={styles.asOfLine} data-testid="views-as-of">{extraLine}</span>}
    </div>
  );
}
