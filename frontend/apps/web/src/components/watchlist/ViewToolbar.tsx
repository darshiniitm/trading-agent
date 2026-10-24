"use client";
import { Button } from "@/ui/Button";
import { ColumnPicker } from "./ColumnPicker";
import { TechTimeframeToggle } from "./TechTimeframeToggle";
import { ViewSwitcher } from "./ViewSwitcher";
import type { Col, Tf, ViewId } from "./viewTypes";
import type { Currency } from "@/lib/viewFormat";
import styles from "./watchlist.module.css";

// Switcher on the left; Currency-in-USD · Download · column picker · ⋮ on the right.
export function ViewToolbar(p: {
  view: ViewId; onView: (v: ViewId) => void;
  ccy: Currency; onCcy: (c: Currency) => void; fxAsOf: string | null; fxAvailable: boolean;
  tf: Tf; onTf: (t: Tf) => void;
  columns: Col[] | null; hidden: string[]; onHidden: (h: string[]) => void;
  onDownload: () => void; onRefreshMetrics: () => void; refreshing: boolean; compact: boolean; onCompact: (c: boolean) => void;
}) {
  return (
    <div className={styles.viewBar}>
      <ViewSwitcher value={p.view} onChange={p.onView} />
      <div className={styles.viewTools}>
        {p.view === "technicals" && <TechTimeframeToggle value={p.tf} onChange={p.onTf} />}
        <label className={styles.ccyToggle} title={p.fxAvailable ? `FX as of ${p.fxAsOf ?? "unknown"}` : "FX rate unavailable"}>
          <input type="checkbox" checked={p.ccy === "USD"} disabled={!p.fxAvailable && p.ccy !== "USD"} onChange={(e) => p.onCcy(e.target.checked ? "USD" : "INR")} /> Currency in USD
        </label>
        <Button size={36} onClick={p.onDownload} aria-label="Download CSV of this view">Download</Button>
        {p.columns && <ColumnPicker columns={p.columns} hidden={p.hidden} onChange={p.onHidden} />}
        <details className={styles.moreMenu}>
          <summary aria-label="More options">⋮</summary>
          <div role="menu" className={styles.menuPanel}>
            <button type="button" role="menuitem" onClick={p.onRefreshMetrics} disabled={p.refreshing}>{p.refreshing ? "Refreshing metrics…" : "Refresh metrics"}</button>
            <button type="button" role="menuitemcheckbox" aria-checked={p.compact} onClick={() => p.onCompact(!p.compact)}>{p.compact ? "✓ " : ""}Compact rows</button>
          </div>
        </details>
      </div>
    </div>
  );
}
