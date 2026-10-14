import styles from "./Button.module.css";

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "accentOutline" | "ghost";
  size?: 44 | 40 | 36;
  // Why the button is disabled; shown as visible text next to it, not only as a tooltip.
  disabledReason?: string | null;
};

export function Button({ variant = "secondary", size = 40, disabledReason, disabled, className, type = "button", children, ...rest }: Props) {
  const isDisabled = disabled || !!disabledReason;
  const button = (
    <button type={type} disabled={isDisabled} className={`${styles.btn} ${styles[`s${size}`]} ${styles[variant]} ${className ?? ""}`} {...rest}>{children}</button>
  );
  if (!disabledReason) return button;
  return <span className={styles.wrap}>{button}<span className={styles.reason}>{disabledReason}</span></span>;
}

export function LinkButton({ href, variant = "secondary", size = 40, children }: { href: string; variant?: Props["variant"]; size?: Props["size"]; children: React.ReactNode }) {
  return <a href={href} className={`${styles.btn} ${styles[`s${size}`]} ${styles[variant ?? "secondary"]}`}>{children}</a>;
}
