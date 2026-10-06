type Event = { type: string; fromValue: string | null; toValue: string | null; at: string };

const LABEL: Record<string, (e: Event) => string> = {
  status_changed: (e) => `Status changed: ${e.fromValue} → ${e.toValue}`,
  membership_changed: (e) => `Membership changed: ${e.fromValue} → ${e.toValue}`,
  dropped_from_screen: () => "Dropped from screen",
};

export function EntryTimeline({ events }: { events: Event[] }) {
  if (events.length === 0) return <p>No history yet</p>;
  return (
    <ul>
      {events.map((e, i) => (
        <li key={i}>{e.at} — {(LABEL[e.type] ?? ((ev: Event) => `${ev.type}: ${ev.fromValue} → ${ev.toValue}`))(e)}</li>
      ))}
    </ul>
  );
}
