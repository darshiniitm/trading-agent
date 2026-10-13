import styles from "./Pill.module.css";

export type PillTone = "neutral" | "blue" | "amber" | "orange" | "positive" | "negative";

export function Pill({ tone = "neutral", dashed, children, ...rest }: { tone?: PillTone; dashed?: boolean; children: React.ReactNode } & React.HTMLAttributes<HTMLSpanElement>) {
  const toneClass = tone === "neutral" ? "" : styles[tone];
  return <span {...rest} className={`${styles.pill} ${toneClass} ${dashed ? styles.dashed : ""}`}>{children}</span>;
}
