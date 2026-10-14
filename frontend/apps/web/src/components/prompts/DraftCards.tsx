import { IdBadge } from "@/ui/IdBadge";
import { LinkButton } from "@/ui/Button";
import { fmtDate } from "@/lib/watchlistMath";
import styles from "./prompts.module.css";

export type DraftRow = { draftId: number; title: string | null; lastEditedAt: string; blockedReason: string | null; promptText?: string };

export function DraftCards({ drafts, selected, onToggle }: { drafts: DraftRow[]; selected?: ReadonlySet<number>; onToggle?: (draftId: number) => void }) {
  if (drafts.length === 0) return <p className={styles.empty}>No drafts. Start one with “New prompt”.</p>;
  return (
    <div className={styles.drafts}>
      {drafts.map((d) => (
        <article key={d.draftId} className={styles.draft}>
          <div className={styles.draftHead}>
            {onToggle && <input type="checkbox" aria-label={`select draft ${d.draftId}`} checked={selected?.has(d.draftId) ?? false} onChange={() => onToggle(d.draftId)} />}
            <IdBadge kind="draft" id={d.draftId} copyable={false} /> <span className={styles.sub}>Edited {fmtDate(d.lastEditedAt)}</span>
          </div>
          {d.promptText ? <p className={styles.draftText}>{d.promptText}</p> : null}
          <p className={d.blockedReason && /unsupported/i.test(d.blockedReason) ? styles.blockRed : styles.blockAmber}>{d.blockedReason ?? "Ready to confirm"}</p>
          <div><LinkButton href={`/drafts/${d.draftId}`} size={36}>Continue</LinkButton></div>
        </article>
      ))}
    </div>
  );
}
