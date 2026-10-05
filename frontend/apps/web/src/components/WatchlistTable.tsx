import { StatusChip } from "@/components/StatusChip";

type Entry = {
  entryId: number; symbol: string; membership: string; status: string;
  entryPrice: number | null; stop: number | null; refPrice: number | null;
  condValues: Record<string, unknown>; failedIds: string[];
};

type Quote = { price: number | null; asOf: string | null; error: string | null };

export function WatchlistTable({
  entries,
  conditionNames,
  quotes = {},
}: {
  entries: Entry[];
  conditionNames: string[];
  quotes?: Record<string, Quote>;
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>Stock</th>
          <th>LTP</th>
          <th>Status</th>
          {conditionNames.map((name) => (
            <th key={name}>{name}</th>
          ))}
          <th>Entry / Stop</th>
          <th>Since entry</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => {
          const quote = quotes[e.symbol];
          return (
            <tr key={e.entryId}>
              <td>{e.symbol}</td>
              <td>{quote ? (quote.error ?? quote.price ?? "—") : "—"}</td>
              <td><StatusChip status={e.status} /></td>
              {conditionNames.map((name) => (
                <td key={name}>{String(e.condValues[name] ?? "—")}</td>
              ))}
              <td>{e.entryPrice ?? "—"} / {e.stop ?? "—"}</td>
              <td>{e.membership === "full_match" ? (e.entryPrice ? "since entry" : "—") : e.refPrice ? "since ref" : "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
