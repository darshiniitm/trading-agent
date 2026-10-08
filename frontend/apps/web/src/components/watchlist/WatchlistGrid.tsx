"use client";
import { useRef } from "react";
import { GridTable, gridRowClass, gridSelectedClass } from "@/ui/GridTable";
import { ConditionFlags } from "@/ui/ConditionFlags";
import { Sparkline } from "@/ui/Sparkline";
import { Pill } from "@/ui/Pill";
import { StatusChip } from "@/components/StatusChip";
import { fmtDate, fmtPrice, fmtSignedPct, sinceEntry, type QuoteLike } from "@/lib/watchlistMath";
import styles from "./watchlist.module.css";

export type GridEntry = {
  entryId: number; symbol: string; name?: string | null; membership: string; status: string; entryPrice: number | null; stop: number | null;
  refPrice: number | null; failedIds: string[]; addedAsOf?: string | null;
};
export type GridCond = { condNo: number; label: string };

const COLS = "minmax(150px,1.4fr) 90px 70px 70px 170px 100px 130px 130px 100px";
const signClass = (n: number | null | undefined) => (n === null || n === undefined ? "" : n < 0 ? styles.neg : styles.pos);

export function WatchlistGrid({ entries, conditions, quotes, stale, closes, selectedId, onSelect }: {
  entries: GridEntry[]; conditions: GridCond[]; quotes: Record<string, QuoteLike>; stale: Set<string>;
  closes: Record<string, number[]>; selectedId: number | null; onSelect: (id: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  function onKeyDown(ev: React.KeyboardEvent) {
    if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
    ev.preventDefault();
    const i = entries.findIndex((e) => e.entryId === selectedId);
    const next = entries[Math.min(entries.length - 1, Math.max(0, i + (ev.key === "ArrowDown" ? 1 : -1)))];
    if (next) {
      onSelect(next.entryId);
      requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`[data-entry="${next.entryId}"]`)?.focus());
    }
  }
  return (
    <div ref={ref} onKeyDown={onKeyDown}>
      <GridTable
        label="Watchlist stocks" cols={COLS} minWidth={1020} rows={entries} rowKey={(e) => e.entryId} empty="No stocks in this view."
        columns={[["stock", "Stock"], ["ltp", "LTP"], ["today", "Today"], ["added", "Added"], ["status", "Status"], ["since", "Since entry"], ["flags", "Conditions"], ["levels", "Entry / Stop"], ["spark", "12-wk"]].map(([key, header]) => ({ key, header }))}
        renderRow={(e) => {
          const q = quotes[e.symbol];
          const since = sinceEntry({ ...e }, q);
          return (
            <button type="button" data-entry={e.entryId} aria-pressed={selectedId === e.entryId} className={`${gridRowClass} ${selectedId === e.entryId ? gridSelectedClass : ""}`} onClick={() => onSelect(e.entryId)}>
              <span><strong className="mono">{e.symbol}</strong>{e.name ? <><br /><span className={styles.sub}>{e.name}</span></> : null}</span>
              <span className="mono" title={q?.error ?? undefined}>{q ? (q.error ? "n/a" : fmtPrice(q.price)) : "—"}{stale.has(e.symbol) && <> <Pill tone="amber">stale</Pill></>}</span>
              <span className={`mono ${signClass(q?.chgPct)}`}>{fmtSignedPct(q?.chgPct)}</span>
              <span className={styles.sub}>{fmtDate(e.addedAsOf)}</span>
              <span><StatusChip status={e.status} /></span>
              <span className={`mono ${signClass(since?.pct)}`}>{since ? `${fmtSignedPct(since.pct)}${since.ref ? " ref" : ""}` : "—"}</span>
              <span><ConditionFlags conds={conditions.map((c) => ({ id: `C${c.condNo}`, label: c.label, met: !e.failedIds.includes(`C${c.condNo}`) }))} /></span>
              <span className="mono">{e.entryPrice ? fmtPrice(e.entryPrice) : "—"} / {e.stop ? fmtPrice(e.stop) : "—"}</span>
              <span><Sparkline values={closes[e.symbol]} /></span>
            </button>
          );
        }}
      />
    </div>
  );
}
