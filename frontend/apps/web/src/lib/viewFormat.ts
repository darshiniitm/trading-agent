// Pure formatters for the P6 watchlist views. IBM Plex Mono is applied by the grid; this only builds strings.
const MINUS = "−";

export const fmtNum = (n: number | null | undefined, digits = 2): string =>
  n === null || n === undefined || !Number.isFinite(n) ? "—" : n.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits }).replace("-", MINUS);

/** 10_560_000_000_000 -> "10.56 T"; below 1,000 the plain number. K / M / B / T as in the TradingView watchlist. */
export function fmtCompact(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const units: [number, string][] = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [size, unit] of units) if (abs >= size) return `${(n / size).toFixed(digits).replace("-", MINUS)} ${unit}`;
  return fmtNum(n, digits);
}

export const fmtSigned = (n: number | null | undefined, digits = 2): string =>
  n === null || n === undefined || !Number.isFinite(n) ? "—" : `${n < 0 ? MINUS : "+"}${Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

export const fmtPctSigned = (n: number | null | undefined, digits = 2): string => (n === null || n === undefined || !Number.isFinite(n) ? "—" : `${fmtSigned(n, digits)}%`);
export const fmtPctPlain = (n: number | null | undefined, digits = 2): string => (n === null || n === undefined || !Number.isFinite(n) ? "—" : `${fmtNum(n, digits)}%`);

export const toneOf = (n: number | null | undefined): "pos" | "neg" | undefined => (n === null || n === undefined || !Number.isFinite(n) || n === 0 ? undefined : n < 0 ? "neg" : "pos");

export type Currency = "INR" | "USD";
/** INR -> USD multiplies by usdPerInr (= 1 / USDINR=X). Returns null when a USD view has no FX rate. Non-INR sources are left alone. */
export function convertMoney(n: number | null | undefined, source: string | null | undefined, target: Currency, usdPerInr: number | null): { value: number | null; unit: string } {
  const src = source ?? "INR";
  if (n === null || n === undefined || !Number.isFinite(n)) return { value: null, unit: target === "USD" && src === "INR" ? "USD" : src };
  if (target === "USD" && src === "INR") return usdPerInr ? { value: n * usdPerInr, unit: "USD" } : { value: null, unit: "USD" };
  return { value: n, unit: src };
}
