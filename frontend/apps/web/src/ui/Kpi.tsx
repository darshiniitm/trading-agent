import styles from "./Kpi.module.css";

export function Kpi({ label, value, note, tone }: { label: string; value: React.ReactNode; note?: React.ReactNode; tone?: "positive" | "negative" | "amber" }) {
  return (
    <div className={styles.kpi}>
      <div className={styles.label}>{label}</div>
      <div className={`${styles.value} ${tone ? styles[tone] : ""}`}>{value}</div>
      {note && <div className={styles.note}>{note}</div>}
    </div>
  );
}
