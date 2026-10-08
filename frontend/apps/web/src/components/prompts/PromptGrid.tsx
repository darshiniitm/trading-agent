"use client";
import { GridTable } from "@/ui/GridTable";
import { Pill } from "@/ui/Pill";
import { Button, LinkButton } from "@/ui/Button";
import { fmtSignedPct } from "@/lib/watchlistMath";
import styles from "./prompts.module.css";

export type PromptRow = {
  promptId: number; title: string; status?: string; visibility?: string; gradedWeeks: number; version?: number; parentPromptId?: number | null;
  lastHorizon1Return: number | null; lastHorizon1Control?: number | null; followers?: number; ownerName?: string; watchlistId?: number | null;
};

const MINE_COLS = "70px minmax(180px,2fr) 90px 150px 100px 150px 90px 170px";
const FOLLOW_COLS = "70px minmax(180px,2fr) 130px 100px 150px 170px";

function ArmVsControl({ arm, control }: { arm: number | null; control: number | null | undefined }) {
  if (arm === null) return <span className={styles.sub}>not graded yet</span>;
  return <span className={`${styles.mono} ${arm < 0 ? styles.neg : styles.pos}`}>{fmtSignedPct(arm, 2)}<span className={styles.sub}> vs {fmtSignedPct(control ?? null, 2)}</span></span>;
}

export function PromptGrid({ rows, mode, selectedId, onSelect, onEdit, onRetire, onShare }: {
  rows: PromptRow[]; mode: "mine" | "following"; selectedId?: number | null; onSelect?: (id: number) => void;
  onEdit?: (id: number) => void; onRetire?: (id: number) => void; onShare?: (id: number, shared: boolean) => void;
}) {
  if (mode === "following") {
    return (
      <GridTable label="Prompts you follow" cols={FOLLOW_COLS} minWidth={760} rows={rows} rowKey={(r) => r.promptId} empty="You aren't following any prompts yet."
        columns={[["id", "Prompt #"], ["title", "Title"], ["owner", "Owner"], ["graded", "Graded"], ["arm", "Arm vs Control"], ["act", ""]].map(([key, header]) => ({ key, header }))}
        renderRow={(r) => (
          <div className={styles.rowBox} style={{ ["--cols" as any]: FOLLOW_COLS }}>
            <span className={styles.mono}>{r.promptId}</span><span>{r.title}</span><span>{r.ownerName}</span>
            <span>week {r.gradedWeeks} of 13</span><ArmVsControl arm={r.lastHorizon1Return} control={r.lastHorizon1Control} />
            <span><LinkButton href={`/explore`} size={36}>Open in Explore</LinkButton></span>
          </div>
        )} />
    );
  }
  return (
    <GridTable label="Your prompts" cols={MINE_COLS} minWidth={1080} rows={rows} rowKey={(r) => r.promptId} empty="You haven't saved a prompt yet."
      columns={[["id", "Prompt #"], ["title", "Title"], ["owner", "Owner"], ["status", "Status"], ["graded", "Graded"], ["arm", "Arm vs Control"], ["fol", "Followers"], ["act", ""]].map(([key, header]) => ({ key, header }))}
      renderRow={(r) => {
        const inactive = r.status === "superseded" || r.status === "retired";
        return (
          <div className={`${styles.rowBox} ${selectedId === r.promptId ? styles.rowSel : ""}`} style={{ ["--cols" as any]: MINE_COLS }}>
            <button type="button" className={styles.mono} style={{ background: "none", border: 0, textAlign: "left", padding: 0 }} onClick={() => onSelect?.(r.promptId)} aria-label={`Prompt ${r.promptId} version history`}>{r.promptId}</button>
            <span className={styles.cell}><span>{r.title}</span><span className={styles.sub}>version {r.version}{r.parentPromptId ? ` · replaces Prompt ${r.parentPromptId}` : ""}</span></span>
            <span>you</span>
            <span><Pill tone={r.status === "confirmed" ? "blue" : "neutral"} dashed={inactive}>{r.status}</Pill> <span className={styles.sub}>{r.visibility}</span></span>
            <span>week {r.gradedWeeks} of 13</span>
            <ArmVsControl arm={r.lastHorizon1Return} control={r.lastHorizon1Control} />
            <span className={styles.mono}>{r.followers ?? 0}</span>
            <span className={styles.actions}>
              {r.watchlistId != null && <LinkButton href={`/watchlists/${r.watchlistId}`} size={36} variant={inactive ? "ghost" : "secondary"}>{inactive ? "View history" : "Open watchlist"}</LinkButton>}
              {r.status === "confirmed" && (
                <>
                  <Button size={36} onClick={() => onEdit?.(r.promptId)}>Edit as new version</Button>
                  <Button size={36} variant="ghost" onClick={() => onRetire?.(r.promptId)}>Retire</Button>
                  <Button size={36} variant="ghost" onClick={() => onShare?.(r.promptId, r.visibility === "shared")}>{r.visibility === "shared" ? "Unshare" : "Share"}</Button>
                </>
              )}
            </span>
          </div>
        );
      }} />
  );
}
