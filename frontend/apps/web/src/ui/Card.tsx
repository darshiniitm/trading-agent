import styles from "./Card.module.css";

export function Card({ tone = "default", title, aside, children, ...rest }: { tone?: "default" | "warn"; title?: React.ReactNode; aside?: React.ReactNode; children?: React.ReactNode } & Omit<React.HTMLAttributes<HTMLElement>, "title">) {
  return (
    <section {...rest} className={`${styles.card} ${tone === "warn" ? styles.warn : ""}`}>
      {(title || aside) && <div className={styles.head}>{title && <h2 className={styles.title}>{title}</h2>}{aside}</div>}
      {children}
    </section>
  );
}
