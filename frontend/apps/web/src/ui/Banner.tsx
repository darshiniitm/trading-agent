import styles from "./Banner.module.css";

export function Banner({ tone = "info", children, ...rest }: { tone?: "warn" | "info"; children: React.ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={`${styles.banner} ${tone === "warn" ? styles.warn : ""}`}>
      <svg className={styles.icon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={tone === "warn" ? "var(--amber)" : "var(--blue)"} strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.5" /></svg>
      <div>{children}</div>
    </div>
  );
}
