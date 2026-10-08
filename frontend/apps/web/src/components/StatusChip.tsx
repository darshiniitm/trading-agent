import { Pill, type PillTone } from "@/ui/Pill";

export const STATUS_LABEL: Record<string, string> = {
  pending_selection: "Selection pending",
  entered: "Entered",
  not_confirmed: "Not confirmed at open",
  no_point_data: "No point data",
  watching: "Watching · not graded",
  dropped_from_screen: "Dropped from screen",
  stopped_out: "Stopped out",
  removed_by_user: "Removed",
  closed: "Closed",
};

// Status is always text; the tone only reinforces it (blue = in the forward test, amber = needs a look, grey = inactive).
const TONE: Record<string, { tone: PillTone; dashed?: boolean }> = {
  entered: { tone: "blue" },
  pending_selection: { tone: "blue", dashed: true },
  not_confirmed: { tone: "amber" },
  no_point_data: { tone: "amber" },
  watching: { tone: "neutral", dashed: true },
};

export function StatusChip({ status }: { status: string }) {
  const t = TONE[status] ?? { tone: "neutral" as PillTone, dashed: true };
  return <Pill tone={t.tone} dashed={t.dashed} className="status-chip">{STATUS_LABEL[status] ?? status}</Pill>;
}
