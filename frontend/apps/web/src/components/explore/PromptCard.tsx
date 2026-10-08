"use client";
import { ConditionChip } from "@/ui/ConditionChip";
import { IdBadge } from "@/ui/IdBadge";
import { Button } from "@/ui/Button";
import styles from "./explore.module.css";

export type ExploreRow = {
  promptId: number; title: string; ownerName: string; isMine: boolean; followers: number; gradedWeeks: number; isFollowing: boolean;
  conditionLabels?: string[]; vsControl?: number | null; watchlistId?: number | null;
};

export function PromptCard({ row, onFollow, onCopy }: { row: ExploreRow; onFollow: (row: ExploreRow) => void; onCopy: (id: number) => void }) {
  return (
    <article className={styles.card}>
      <div className={styles.head}>
        <IdBadge kind="prompt" id={row.promptId} />
        <span className={styles.by}>by {row.ownerName}{row.isMine ? " · Yours" : ""}</span>
      </div>
      <h2>{row.title}</h2>
      <div className={styles.chips}>{(row.conditionLabels ?? []).map((l, i) => <ConditionChip key={i} id={`C${i + 1}`} text={l} />)}</div>
      <div className={styles.tiles}>
        <div className={styles.tile}><div className={styles.tileLabel}>Graded</div><div className={styles.tileValue}>{row.gradedWeeks} of 13</div></div>
        <div className={styles.tile}><div className={styles.tileLabel}>vs Control</div><div className={styles.tileValue}>{row.vsControl == null ? "—" : `${row.vsControl < 0 ? "−" : "+"}${Math.abs(row.vsControl).toFixed(2)}%`}</div></div>
        <div className={styles.tile}><div className={styles.tileLabel}>Followers</div><div className={styles.tileValue}>{row.followers}</div></div>
      </div>
      <div className={styles.actions}>
        {row.isMine ? (
          <a href={row.watchlistId ? `/watchlists/${row.watchlistId}` : "/prompts"}>Yours · open watchlist</a>
        ) : (
          <>
            <Button variant={row.isFollowing ? "secondary" : "primary"} aria-pressed={row.isFollowing} onClick={() => onFollow(row)}>{row.isFollowing ? "Following ✓" : "Follow"}</Button>
            <Button onClick={() => onCopy(row.promptId)}>Copy to my drafts</Button>
          </>
        )}
      </div>
    </article>
  );
}
