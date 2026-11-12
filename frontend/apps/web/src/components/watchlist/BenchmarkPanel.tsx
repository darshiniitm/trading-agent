"use client";
import { useQuery } from "@tanstack/react-query";
import { PriceChart } from "@/ui/PriceChart";
import { fmtNum, fmtPctSigned, toneOf } from "@/lib/viewFormat";
import type { ViewRow } from "./viewTypes";
import styles from "./watchlist.module.css";

const TILES: [keyof ViewRow["performance"], string][] = [["w1", "1W"], ["m1", "1M"], ["m3", "3M"], ["ytd", "YTD"], ["y1", "1Y"], ["y5", "5Y"], ["all", "All time"]];

// Slim aside for a benchmark row: price chart + performance tiles only. A benchmark has no status, entry or stop.
export function BenchmarkPanel({ row }: { row: ViewRow }) {
  const hist = useQuery({
    queryKey: ["bench-history", row.symbol], retry: false, staleTime: 5 * 60_000,
    queryFn: async () => { const r = await fetch(`/api/series/history?symbol=${encodeURIComponent(row.symbol)}`); if (!r.ok) throw new Error("no history"); return (await r.json()) as { closes: number[] }; },
  });
  return (
    <div>
      <div className={styles.detailHead}><h3 style={{ margin: 0 }}>{row.name ?? row.symbol} <span className={`mono ${styles.sub}`}>{row.symbol}</span></h3></div>
      <p className={`mono ${styles.price}`}>{row.price.last === null ? "—" : fmtNum(row.price.last)} <span className={styles.sub}>POINT</span></p>
      {row.price.chgPct !== null && <p className={`mono ${toneOf(row.price.chgPct) === "neg" ? styles.neg : styles.pos}`}>{fmtPctSigned(row.price.chgPct)} today</p>}
      {hist.data ? <PriceChart closes={hist.data.closes} /> : <p className={styles.sub}>{hist.isError ? "Chart not available." : "Loading chart…"}</p>}
      <div className={styles.tiles} aria-label="Performance">
        {TILES.map(([k, label]) => {
          const v = row.performance[k] as number | null;
          return <div key={k} className={styles.tile}><div className={styles.tileLabel}>{label}</div><div className={`mono ${toneOf(v) === "neg" ? styles.neg : toneOf(v) === "pos" ? styles.pos : ""}`}>{fmtPctSigned(v)}</div></div>;
        })}
      </div>
      <p className={styles.sub}>Benchmark — not a pick, never graded.</p>
    </div>
  );
}
