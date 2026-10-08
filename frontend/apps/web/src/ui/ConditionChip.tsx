import styles from "./Provenance.module.css";
import { ORIGIN_LABEL, ProvenanceDot, type Origin } from "./ProvenanceDot";

export function ConditionChip({ id, text, origin }: { id: string; text: string; origin?: Origin }) {
  return (
    <span className={styles.chip}>
      {origin && <ProvenanceDot origin={origin} />}
      <span className={styles.id}>{id}</span>
      <span>{text}</span>
      {origin && <span className="visually-hidden">({ORIGIN_LABEL[origin]})</span>}
    </span>
  );
}
