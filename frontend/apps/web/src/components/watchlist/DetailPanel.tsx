"use client";
import { useEffect, useState } from "react";
import { Card } from "@/ui/Card";
import { Banner } from "@/ui/Banner";
import { Button } from "@/ui/Button";
import { Dialog } from "@/ui/Dialog";
import { LevelTiles } from "@/ui/LevelTiles";
import { PriceChart } from "@/ui/PriceChart";
import { StatusChip } from "@/components/StatusChip";
import { EntryTimeline } from "@/components/EntryTimeline";
import { fmtDate, fmtPrice, fmtSignedPct, sinceEntry, type QuoteLike } from "@/lib/watchlistMath";
import type { GridEntry } from "./WatchlistGrid";
import styles from "./watchlist.module.css";

export type DetailEntry = GridEntry & { sector?: string | null; condValues: Record<string, unknown>; entryDate?: string | null };
export type DetailExtra = { userNote: string | null; events: { type: string; fromValue: string | null; toValue: string | null; at: string }[] };
export type SeriesBar = { close: number | null; vstop_line?: number | null };

// Tiles switch on status exactly as the canvas's cases: entered / pending / not confirmed / shadow.
export function levelTiles(e: DetailEntry, quote: QuoteLike | undefined, entryAt: string | null) {
  const last = quote?.price ?? null;
  const since = sinceEntry(e, quote);
  if (e.status === "entered") return [
    { label: "Entry price", value: fmtPrice(e.entryPrice) }, { label: "Stop", value: fmtPrice(e.stop) },
    { label: "Since entry", value: fmtSignedPct(since?.pct) }, { label: "Entered", value: fmtDate(e.entryDate) },
  ];
  if (e.status === "pending_selection") return [
    { label: "Reference price", value: fmtPrice(e.refPrice) }, { label: "Planned stop", value: fmtPrice(e.stop) },
    { label: "Last price", value: fmtPrice(last) }, { label: "Entry", value: entryAt ? entryAt.replace(/_/g, " ") : "at selection" },
  ];
  if (e.status === "not_confirmed") return [
    { label: "Reference price", value: fmtPrice(e.refPrice) }, { label: "Last price", value: fmtPrice(last) },
    { label: "Status", value: "Not confirmed" }, { label: "Graded", value: "No" },
  ];
  return [
    { label: "Reference price", value: fmtPrice(e.refPrice) }, { label: "Last price", value: fmtPrice(last) },
    { label: "Since ref", value: fmtSignedPct(since?.pct) }, { label: "Graded", value: "No — shadow" },
  ];
}

export function DetailPanel({ entry, conditions, quote, bars, extra, entryAt, onSaveNote, onRemove, canRemove = true }: {
  entry: DetailEntry; conditions: { condNo: number; label: string }[]; quote?: QuoteLike; bars: SeriesBar[] | null; extra: DetailExtra | null;
  entryAt: string | null; onSaveNote: (note: string) => Promise<boolean>; onRemove: () => Promise<void>; canRemove?: boolean;
}) {
  const [note, setNote] = useState(extra?.userNote ?? "");
  const [saved, setSaved] = useState<string>("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => { setNote(extra?.userNote ?? ""); setSaved(""); }, [entry.entryId, extra?.userNote]);

  const closes = (bars ?? []).map((b) => b.close).filter((c): c is number => typeof c === "number").slice(-52);
  const vstop = (bars ?? []).slice(-closes.length).map((b) => b.vstop_line ?? null);
  const hasVstop = vstop.some((v) => v !== null);

  async function blur() {
    if (note === (extra?.userNote ?? "")) return;
    setSaved((await onSaveNote(note)) ? "Saved" : "Couldn't save");
  }

  return (
    <Card aria-label="Stock detail">
      <div className={styles.detailHead}>
        <h2 className="mono">{entry.symbol}</h2>
        <StatusChip status={entry.status} />
      </div>
      <p className={styles.sub}>{[entry.name, entry.sector, entry.addedAsOf ? `added ${fmtDate(entry.addedAsOf)} run` : null].filter(Boolean).join(" · ")}</p>
      {entry.membership !== "full_match" && (
        <Banner tone="warn">Watchlist only — not an arm pick; not counted in forward-test scoring.</Banner>
      )}
      <div className={styles.price}>{quote?.price != null ? fmtPrice(quote.price) : "—"}</div>
      <p className={`mono ${quote?.chgPct === undefined ? "" : quote.chgPct < 0 ? styles.neg : styles.pos}`}>{fmtSignedPct(quote?.chgPct)} today</p>
      {closes.length >= 2 ? <PriceChart closes={closes} overlays={hasVstop ? [{ name: "VStop", values: vstop, color: "var(--blue)" }] : []} /> : <p className={styles.sub}>{bars === null ? "Loading chart…" : "No chart data."}</p>}

      <h3>Your conditions</h3>
      <ul className={styles.condList}>
        {conditions.map((c) => {
          const met = !entry.failedIds.includes(`C${c.condNo}`);
          const v = entry.condValues[`C${c.condNo}`];
          return (
            <li key={c.condNo}>
              <span className={met ? styles.ok : styles.no} aria-hidden="true">{met ? "✓" : "✗"}</span>
              <span className="visually-hidden">{met ? "met" : "not met"}</span>
              <span>C{c.condNo}: {c.label}</span>
              {v !== undefined && v !== null && <span className="mono">{typeof v === "number" ? v.toLocaleString("en-IN") : String(v)}</span>}
            </li>
          );
        })}
      </ul>

      <LevelTiles tiles={levelTiles(entry, quote, entryAt)} />

      <h3 style={{ marginTop: 16 }}><label htmlFor={`note-${entry.entryId}`}>Personal note</label></h3>
      <textarea id={`note-${entry.entryId}`} className={styles.note} value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => void blur()} />
      <p className={styles.sub} role="status">{saved}</p>

      {canRemove && <Button variant="ghost" size={36} onClick={() => setConfirmRemove(true)}>Remove from my watchlist</Button>}
      <Dialog open={confirmRemove} onClose={() => setConfirmRemove(false)} title={`Remove ${entry.symbol}?`}
        actions={<><Button onClick={() => setConfirmRemove(false)}>Cancel</Button><Button variant="primary" onClick={() => { setConfirmRemove(false); void onRemove(); }}>Remove</Button></>}>
        <p className={styles.dialogBody}>This removes the stock from your watchlist only. Other followers and the owner are not affected.</p>
      </Dialog>

      <details style={{ marginTop: 12 }}><summary>History</summary><EntryTimeline events={extra?.events ?? []} /></details>
    </Card>
  );
}
