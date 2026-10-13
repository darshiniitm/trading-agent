export function sparkPath(values: number[], w: number, h: number, pad = 2): string {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length < 2) return "";
  const min = Math.min(...finite), max = Math.max(...finite);
  const span = max - min || 1;
  return finite.map((v, i) => `${i === 0 ? "M" : "L"}${(pad + (i * (w - 2 * pad)) / (finite.length - 1)).toFixed(1)},${(h - pad - ((v - min) / span) * (h - 2 * pad)).toFixed(1)}`).join(" ");
}

export function Sparkline({ values, label = "12-week closes" }: { values: number[] | undefined; label?: string }) {
  const d = values ? sparkPath(values, 88, 28) : "";
  if (!d) return <span aria-label={`${label}: not available`}>—</span>;
  const up = values![values!.length - 1] >= values![0];
  return (
    <svg width="88" height="28" viewBox="0 0 88 28" role="img" aria-label={label}>
      <path d={d} fill="none" stroke={up ? "var(--positive)" : "var(--negative)"} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
