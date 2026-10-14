import styles from "./LevelTiles.module.css";

export function LevelTiles({ tiles }: { tiles: { label: string; value: React.ReactNode }[] }) {
  return (
    <div className={styles.grid}>
      {tiles.map((t) => (
        <div key={t.label} className={styles.tile}><div className={styles.label}>{t.label}</div><div className={styles.value}>{t.value}</div></div>
      ))}
    </div>
  );
}
