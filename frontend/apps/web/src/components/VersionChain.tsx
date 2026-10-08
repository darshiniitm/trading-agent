import styles from "./VersionChain.module.css";

export function VersionChain({ promptId, parentPromptId, version }: { promptId: number; parentPromptId: number | null; version: number }) {
  if (parentPromptId === null) {
    return <span className={styles.chain}><span className={`${styles.box} ${styles.current}`}>Prompt {promptId} (version {version})</span></span>;
  }
  return (
    <span className={styles.chain}>
      <span className={styles.box}>Prompt {parentPromptId}</span>
      <span className={styles.arrow} aria-hidden="true">→</span>
      <span className={`${styles.box} ${styles.current}`}>Prompt {promptId} (version {version})</span>
      <span className={styles.note}>— <em>old versions keep their records and stop being graded</em>. Nothing is rewritten.</span>
    </span>
  );
}
