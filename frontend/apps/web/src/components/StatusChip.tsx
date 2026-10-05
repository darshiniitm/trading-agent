const LABEL: Record<string, string> = {
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

export function StatusChip({ status }: { status: string }) {
  return <span className="status-chip">{LABEL[status] ?? status}</span>;
}
