"use client";
import styles from "./IdBadge.module.css";

export function IdBadge({ kind, id, copyable = true }: { kind: "prompt" | "draft"; id: number; copyable?: boolean }) {
  const label = kind === "prompt" ? "Prompt" : "Draft";
  return (
    <span className={`${styles.badge} ${kind === "draft" ? styles.draft : ""}`}>
      {label} {id}
      {copyable && (
        <button type="button" className={styles.copy} aria-label={`Copy ${label.toLowerCase()} number`} onClick={() => { void navigator.clipboard?.writeText(String(id)); }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></svg>
        </button>
      )}
    </span>
  );
}
