import { Card } from "@/ui/Card";
import { ConditionChip } from "@/ui/ConditionChip";
import { ORIGIN_LABEL, ProvenanceDot, type Origin } from "@/ui/ProvenanceDot";
import styles from "./watchlist.module.css";

type Cond = { condNo: number; label: string; valueOrigin: string };

export function PromptCard({ promptText, conditions, whatRuns }: { promptText: string; conditions: Cond[]; whatRuns: { label: string; on: boolean }[] }) {
  return (
    <Card title="Prompt">
      <blockquote className={styles.quote}>“{promptText}”</blockquote>
      <div className={styles.chips}>
        {conditions.map((c) => <ConditionChip key={c.condNo} id={`C${c.condNo}`} text={c.label} origin={(c.valueOrigin === "user_answer" ? "user_answer" : "prompt") as Origin} />)}
      </div>
      <p className={styles.legend}>
        {(["prompt", "user_answer"] as Origin[]).map((o) => <span key={o}><ProvenanceDot origin={o} /> {ORIGIN_LABEL[o]}</span>)}
      </p>
      {whatRuns.length > 0 && (
        <p className={styles.whatRuns}><strong>What runs:</strong>{" "}
          {whatRuns.map((w, i) => <span key={i} className={styles.runItem}>{w.on ? "✓" : "—"} {w.label}</span>)}
        </p>
      )}
    </Card>
  );
}
