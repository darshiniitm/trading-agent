import styles from "./GridTable.module.css";

export type GridColumn = { key: string; header: string };

// A CSS-grid list: `cols` is the grid-template-columns string, rows are rendered by the caller so a row can be a
// <button> (selectable) or a <div>. The scroll box keeps wide tables from scrolling the page.
export function GridTable<T>({ cols, minWidth, columns, rows, rowKey, renderRow, empty = "Nothing here.", label }: {
  cols: string; minWidth?: number; columns: GridColumn[]; rows: T[]; rowKey: (r: T) => string | number;
  renderRow: (r: T) => React.ReactNode; empty?: string; label?: string;
}) {
  return (
    <div className={styles.scroll} role="region" aria-label={label} tabIndex={0}>
      <div className={styles.inner} style={{ ["--cols" as any]: cols, ["--min-width" as any]: `${minWidth ?? 640}px` }}>
        <div className={styles.head}>{columns.map((c) => <span key={c.key}>{c.header}</span>)}</div>
        {rows.length === 0 ? <div className={styles.empty}>{empty}</div> : rows.map((r) => <div key={rowKey(r)}>{renderRow(r)}</div>)}
      </div>
    </div>
  );
}
export const gridRowClass = styles.row;
export const gridSelectedClass = styles.selected;
