import styles from "./Fields.module.css";

type Common = { label: string; hideLabel?: boolean };

function Wrap({ label, hideLabel, children }: Common & { children: React.ReactNode }) {
  return <label className={styles.field}><span className={hideLabel ? "visually-hidden" : styles.label}>{label}</span>{children}</label>;
}

export function FieldText({ label, hideLabel, ...rest }: Common & React.InputHTMLAttributes<HTMLInputElement>) {
  return <Wrap label={label} hideLabel={hideLabel}><input type="text" {...rest} /></Wrap>;
}
export function FieldNumber({ label, hideLabel, ...rest }: Common & React.InputHTMLAttributes<HTMLInputElement>) {
  return <Wrap label={label} hideLabel={hideLabel}><input type="number" className={styles.num} {...rest} /></Wrap>;
}
export function FieldSelect({ label, hideLabel, children, ...rest }: Common & React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <Wrap label={label} hideLabel={hideLabel}><select {...rest}>{children}</select></Wrap>;
}
export function FieldTextarea({ label, hideLabel, ...rest }: Common & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <Wrap label={label} hideLabel={hideLabel}><textarea {...rest} /></Wrap>;
}
export function RadioCard({ label, description, checked, ...rest }: { label: string; description?: string; checked: boolean } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "checked">) {
  return (
    <label className={`${styles.radio} ${checked ? styles.radioOn : ""}`}>
      <input type="radio" checked={checked} {...rest} />
      <span><strong>{label}</strong>{description && <><br /><span className={styles.label}>{description}</span></>}</span>
    </label>
  );
}
export function SegmentedRadio<T extends string>({ name, items, value, onChange }: { name: string; items: { id: T; label: string }[]; value: T; onChange: (id: T) => void }) {
  return (
    <div className={styles.radioGroup} role="radiogroup">
      {items.map((it) => (
        <label key={it.id}><input type="radio" className="visually-hidden" name={name} checked={value === it.id} onChange={() => onChange(it.id)} /><span className={styles.label}>{it.label}</span></label>
      ))}
    </div>
  );
}
