"use client";
import { useMemo, useState } from "react";
import { GridTable, gridRowClass, gridSelectedClass } from "@/ui/GridTable";
import { StatusChip } from "@/components/StatusChip";
import { visibleColumns, type DataView } from "./columns";
import type { Cell, ColCtx, ViewRow, ViewSection } from "./viewTypes";
import styles from "./watchlist.module.css";

export const rowKeyOf = (r: ViewRow) => (r.entryId !== undefined ? `entry:${r.entryId}` : `bench:${r.symbol}`);
type Item = { type: "section"; section: ViewSection; open: boolean; count: number } | { type: "row"; row: ViewRow; section: ViewSection };

const toneClass = (c: Cell) => (c.tone === "pos" ? styles.pos : c.tone === "neg" ? styles.neg : c.tone === "muted" ? styles.sub : "");

// One symbol list, grouped in sections, with a column set per view. Display only.
export function ViewGrid({ view, sections, hidden, ctx, query, selectedKey, onSelect, compact }: {
  view: DataView; sections: ViewSection[]; hidden: Record<string, string[]> | undefined; ctx: ColCtx; query: string;
  selectedKey: string | null; onSelect: (row: ViewRow) => void; compact: boolean;
}) {
  const cols = visibleColumns(view, hidden);
  const [openOverride, setOpen] = useState<Record<string, boolean>>({});
  const needle = query.trim().toLowerCase();

  const items = useMemo(() => {
    const out: Item[] = [];
    for (const s of sections) {
      const rows = s.rows.filter((r) => !needle || r.symbol.toLowerCase().includes(needle) || (r.name ?? "").toLowerCase().includes(needle));
      const open = openOverride[s.id] ?? !s.collapsedByDefault;
      out.push({ type: "section", section: s, open, count: rows.length });
      if (open) rows.forEach((row) => out.push({ type: "row", row, section: s }));
    }
    return out;
  }, [sections, needle, openOverride]);

  const gridCols = `minmax(160px,1.3fr) ${cols.map((c) => (c.id.endsWith("Rating") ? "minmax(120px,1fr)" : "minmax(96px,1fr)")).join(" ")}`;
  const headerCols = [{ key: "symbol", header: "Symbol" }, ...cols.map((c) => ({ key: c.id, header: c.label }))];

  return (
    <GridTable
      label={`Watchlist ${view} view`} cols={gridCols} minWidth={160 + cols.length * 104} rows={items}
      rowKey={(i) => (i.type === "section" ? `s:${i.section.id}` : rowKeyOf(i.row))} empty="No stocks in this view."
      columns={headerCols.map((c) => ({ key: c.key, header: c.header }))}
      renderRow={(i) => {
        if (i.type === "section") {
          return (
            <button type="button" className={styles.sectionHead} aria-expanded={i.open} onClick={() => setOpen((o) => ({ ...o, [i.section.id]: !i.open }))}>
              <span aria-hidden="true">{i.open ? "▾" : "▸"}</span> {i.section.label} <span className={styles.sub}>{i.count}</span>
            </button>
          );
        }
        const { row } = i;
        const key = rowKeyOf(row);
        return (
          <button type="button" data-row={key} aria-pressed={selectedKey === key} className={`${gridRowClass} ${compact ? styles.compactRow : ""} ${selectedKey === key ? gridSelectedClass : ""}`} onClick={() => onSelect(row)}>
            <span className={styles.symCell}>
              <strong className="mono">{row.symbol}</strong>
              {row.status && <> <StatusChip status={row.status} /></>}
              {row.name ? <><br /><span className={styles.sub}>{row.name}</span></> : null}
            </span>
            {cols.map((c) => {
              const cell = c.get(row, ctx);
              return (
                <span key={c.id} className={`mono ${toneClass(cell)} ${c.align === "right" ? styles.right : ""}`} title={cell.title}>
                  {cell.icon && <span aria-hidden="true" className={styles.ratingIcon}>{cell.icon} </span>}{cell.text}
                </span>
              );
            })}
          </button>
        );
      }}
    />
  );
}
