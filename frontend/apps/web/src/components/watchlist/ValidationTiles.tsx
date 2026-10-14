import { Card } from "@/ui/Card";
import { fmtDate, fmtSignedPct } from "@/lib/watchlistMath";
import styles from "./watchlist.module.css";

type Horizon = { horizon: number; n: number; ewReturn: number | null; hitRate: number | null };

// Three horizon tiles: the arm's equal-weight return beside Control's, or "Pending" until the horizon matures.
export function ValidationTiles({ gradedWeeks, horizons, gradedAsOf, dueDates = {}, controls = {} }: {
  gradedWeeks: number; horizons: Horizon[]; gradedAsOf?: string | null; dueDates?: Record<string, string>; controls?: Record<string, number | null>;
}) {
  return (
    <Card title="Validation" aside={<span className={styles.sub}>Graded week {gradedWeeks} of 13{gradedAsOf ? ` · picks from the ${fmtDate(gradedAsOf)} run` : ""} · near misses are not graded</span>}>
      <p className={styles.sub}><em>arm picks vs Control only</em></p>
      <div className={styles.tiles}>
        {[1, 2, 3].map((h) => {
          const row = horizons.find((x) => x.horizon === h);
          const ret = row?.ewReturn ?? null;
          const control = controls[String(h)] ?? null;
          return (
            <div key={h} className={styles.tile}>
              <div className={styles.tileLabel}>{h} week{h === 1 ? "" : "s"}</div>
              {ret === null ? (
                <><div className="mono">Pending</div><div className={styles.sub}>{dueDates[String(h)] ? `After ${fmtDate(dueDates[String(h)], true)} close` : "Not graded yet"}</div></>
              ) : (
                <><div className={`mono ${ret < 0 ? styles.neg : styles.pos}`}>{fmtSignedPct(ret, 2)}</div><div className={styles.sub}>Control {fmtSignedPct(control, 2)} · n {row?.n}{row?.hitRate != null ? ` · hit ${(row.hitRate * 100).toFixed(0)}%` : ""}</div></>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
