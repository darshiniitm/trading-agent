type Horizon = { horizon: 1 | 2 | 3; n: number; ewReturn: number | null; hitRate: number | null };

export function ValidationCard({ gradedWeeks, horizons }: { gradedWeeks: number; horizons: Horizon[] }) {
  return (
    <section>
      <h2>Validation</h2>
      <p>Graded week {gradedWeeks} of 13</p>
      <p><em>arm picks vs Control only — near misses are not graded</em></p>
      {horizons.length === 0 ? (
        <p>No horizons graded yet</p>
      ) : (
        <table>
          <thead><tr><th>Horizon</th><th>n</th><th>Return</th><th>Hit rate</th></tr></thead>
          <tbody>
            {horizons.map((h) => (
              <tr key={h.horizon}>
                <td>{h.horizon}w</td>
                <td>{h.n}</td>
                <td>{h.ewReturn === null ? "—" : `${h.ewReturn.toFixed(2)}%`}</td>
                <td>{h.hitRate === null ? "—" : `${(h.hitRate * 100).toFixed(0)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
