import { IdBadge } from "@/ui/IdBadge";
import { Pill } from "@/ui/Pill";
import { Button } from "@/ui/Button";
import { fmtDate } from "@/lib/watchlistMath";
import styles from "./watchlist.module.css";

export type HeaderView = {
  promptId: number; title: string; ownerName: string; isOwner: boolean; visibility: string; followers: number;
  version: number; parentPromptId: number | null; confirmedAt: string; hypothesis?: string | null;
};

export function Header({ view, onEdit, onDryRun, onExport, busy }: { view: HeaderView; onEdit: () => void; onDryRun: () => void; onExport: () => void; busy?: boolean }) {
  const meta = [
    `Owner: ${view.isOwner ? "you" : view.ownerName}`,
    view.visibility === "shared" ? "Shared" : "Private",
    `${view.followers} follower${view.followers === 1 ? "" : "s"}`,
    `version ${view.version}${view.parentPromptId ? ` (replaces Prompt ${view.parentPromptId})` : ""}`,
    `confirmed ${fmtDate(view.confirmedAt)}`,
  ].join(" · ");
  return (
    <div className={styles.header}>
      <div>
        <div className={styles.titleRow}>
          <IdBadge kind="prompt" id={view.promptId} />
          <Pill tone="blue">Shadow arm · graded vs Control</Pill>
        </div>
        <h1>{view.title}</h1>
        <p className={styles.meta}>{meta}</p>
        {view.hypothesis ? <p className={styles.meta}>{view.hypothesis}</p> : null}
      </div>
      <div className={styles.actions}>
        {view.isOwner && <Button variant="accentOutline" onClick={onEdit}>Edit as new version</Button>}
        <Button onClick={onExport}>Export CSV</Button>
        <span title="Not recorded in the forward test"><Button onClick={onDryRun} disabled={busy}>Dry run now</Button></span>
      </div>
    </div>
  );
}
