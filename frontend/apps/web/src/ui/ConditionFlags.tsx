import styles from "./ConditionFlags.module.css";

export type Flag = { id: string; label: string; met: boolean };

export function ConditionFlags({ conds }: { conds: Flag[] }) {
  const metCount = conds.filter((c) => c.met).length;
  return (
    <span className={styles.row}>
      {conds.map((c) => (
        <span key={c.id} className={`${styles.sq} ${c.met ? styles.met : styles.unmet}`} title={`${c.id}: ${c.label} — ${c.met ? "met" : "not met"}`}>
          <span className="visually-hidden">{c.id} {c.met ? "met" : "not met"}</span>
        </span>
      ))}
      <span className={styles.count}>{metCount}/{conds.length}</span>
    </span>
  );
}
