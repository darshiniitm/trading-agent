import styles from "./Segmented.module.css";

export type SegmentItem<T extends string> = { id: T; label: string; count?: number };

export function Segmented<T extends string>({ items, value, onChange, label }: { items: SegmentItem<T>[]; value: T; onChange: (id: T) => void; label?: string }) {
  return (
    <div className={styles.group} role="group" aria-label={label}>
      {items.map((it) => (
        <button key={it.id} type="button" className={styles.seg} aria-pressed={value === it.id} onClick={() => onChange(it.id)}>
          {it.label}{it.count !== undefined && <span className={styles.count}>{it.count}</span>}
        </button>
      ))}
    </div>
  );
}
