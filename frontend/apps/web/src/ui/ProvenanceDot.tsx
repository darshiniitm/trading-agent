import styles from "./Provenance.module.css";

export type Origin = "prompt" | "user_answer" | "user_convention" | "assumed" | "inferred";

export const ORIGIN_LABEL: Record<Origin, string> = {
  prompt: "from the prompt",
  user_answer: "your answer",
  user_convention: "your convention",
  assumed: "assumed",
  inferred: "inferred",
};

// Decorative: the text label always travels with it, so colour/shape is never the only cue.
export function ProvenanceDot({ origin }: { origin: Origin }) {
  return <span className={`${styles.dot} ${styles[origin]}`} aria-hidden="true" />;
}
