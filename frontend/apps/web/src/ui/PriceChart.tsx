import styles from "./Charts.module.css";
import { sparkPath } from "./Sparkline";

export type Overlay = { name: string; values: (number | null)[]; color: string };

const W = 320, H = 150;

export function PriceChart({ closes, overlays = [] }: { closes: number[]; overlays?: Overlay[] }) {
  const all = [...closes, ...overlays.flatMap((o) => o.values.filter((v): v is number => v !== null))].filter(Number.isFinite);
  if (closes.length < 2 || all.length === 0) return <p>No chart data.</p>;
  const min = Math.min(...all), max = Math.max(...all), span = max - min || 1, pad = 6;
  const x = (i: number, n: number) => pad + (i * (W - 2 * pad)) / Math.max(n - 1, 1);
  const y = (v: number) => H - pad - ((v - min) / span) * (H - 2 * pad);
  const line = (vals: (number | null)[]) => vals.map((v, i) => (v === null ? null : `${x(i, vals.length).toFixed(1)},${y(v).toFixed(1)}`)).reduce<string[]>((acc, pt, i) => (pt === null ? acc : [...acc, `${acc.length === 0 || vals[i - 1] === null ? "M" : "L"}${pt}`]), []).join(" ");
  return (
    <div>
      <svg className={styles.svg} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Weekly closes">
        {overlays.map((o) => <path key={o.name} d={line(o.values)} fill="none" stroke={o.color} strokeWidth="1.25" strokeDasharray="4 3" />)}
        <path d={sparkPath(closes, W, H, pad)} fill="none" stroke="var(--text)" strokeWidth="1.75" strokeLinejoin="round" />
      </svg>
      <div className={styles.legend}>
        <span><span className={styles.sw} style={{ background: "var(--text)" }} />Weekly close</span>
        {overlays.map((o) => <span key={o.name}><span className={styles.sw} style={{ background: o.color }} />{o.name}</span>)}
      </div>
    </div>
  );
}
