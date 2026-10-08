// Span-checked traceability (P0 item 5): a source phrase only proves a value if
// (a) the phrase actually occurs in the prompt and (b) the value can be re-read
// from the phrase itself. Listing a path is not enough.
export const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

const WORD_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30,
};
const WEEKDAYS: Record<string, number> = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5 };
const STRING_ALIASES: Record<string, RegExp> = {
  "1w": /\b(week|weekly|1\s*w)\b/, "1d": /\b(day|daily|1\s*d)\b/, "1m": /\b(month|monthly|1\s*m)\b/,
  close: /\bclos(e|es|ing)\b/, open: /\bopen(s|ing)?\b/, high: /\bhigh(s)?\b/, low: /\blow(s)?\b/,
  long: /\b(long|up|bullish)\b/,
};

// Every number a phrase can legitimately express: plain, comma-grouped, with a
// K / L(akh) / Cr(ore) suffix, or spelled out.
export function numbersIn(phrase: string): Set<number> {
  const out = new Set<number>();
  const text = norm(phrase);
  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(k|l|lakh|lakhs|cr|crore|crores|%)?(?![a-z])/g)) {
    const n = Number(m[1].replace(/,/g, ""));
    if (Number.isNaN(n)) continue;
    out.add(n);
    const unit = m[2];
    if (unit === "k") out.add(n * 1_000);
    if (unit === "l" || unit === "lakh" || unit === "lakhs") out.add(n * 100_000);
  }
  for (const w of text.match(/[a-z]+/g) ?? []) {
    if (w in WORD_NUMBERS) out.add(WORD_NUMBERS[w]);
    if (w in WEEKDAYS) out.add(WEEKDAYS[w]);
  }
  return out;
}

export function valueTracesToPhrase(value: unknown, phrase: string): boolean {
  if (typeof value === "number") return numbersIn(phrase).has(value);
  if (typeof value === "string") {
    const v = norm(value);
    return norm(phrase).includes(v) || (STRING_ALIASES[v]?.test(norm(phrase)) ?? false);
  }
  return false;
}

type Leaf = { path: string; value: unknown };
type SpanOutput = {
  conditions: { value?: unknown; params?: Record<string, unknown> }[];
  risk_cap_pct?: number | null;
  near_miss?: { max_failed?: number | null } | null;
  selection_point?: { session_of_week?: number | null; at?: string | null } | null;
  t1_window?: { length_sessions?: number | null; offsets?: (number | null)[] } | null;
};
const present = (v: unknown) => v !== null && v !== undefined;

export function leaves(o: SpanOutput): Leaf[] {
  const out: Leaf[] = [];
  o.conditions.forEach((c, i) => {
    if (Array.isArray(c.value)) c.value.forEach((v, j) => present(v) && out.push({ path: `conditions.${i}.value.${j}`, value: v }));
    else if (present(c.value)) out.push({ path: `conditions.${i}.value`, value: c.value });
    for (const [k, v] of Object.entries(c.params ?? {})) if (present(v)) out.push({ path: `conditions.${i}.params.${k}`, value: v });
  });
  if (present(o.risk_cap_pct)) out.push({ path: "risk_cap_pct", value: o.risk_cap_pct });
  if (o.near_miss && present(o.near_miss.max_failed)) out.push({ path: "near_miss.max_failed", value: o.near_miss.max_failed });
  if (o.selection_point) {
    if (present(o.selection_point.session_of_week)) out.push({ path: "selection_point.session_of_week", value: o.selection_point.session_of_week });
    if (present(o.selection_point.at)) out.push({ path: "selection_point.at", value: o.selection_point.at });
  }
  if (o.t1_window) {
    if (present(o.t1_window.length_sessions)) out.push({ path: "t1_window.length_sessions", value: o.t1_window.length_sessions });
    (o.t1_window.offsets ?? []).forEach((v, j) => present(v) && out.push({ path: `t1_window.offsets.${j}`, value: v }));
  }
  return out;
}

// Returns one human-readable problem per failing value (empty = all good).
export function spanProblems(o: SpanOutput, sourcePhrases: { path: string; phrase: string }[], promptText: string): string[] {
  const prompt = norm(promptText);
  const byPath = new Map(sourcePhrases.map((s) => [s.path, s.phrase]));
  const problems: string[] = [];
  for (const { path, value } of leaves(o)) {
    const phrase = byPath.get(path);
    if (phrase === undefined) continue; // missing phrases are reported by assertTraceable
    if (!prompt.includes(norm(phrase))) {
      problems.push(`${path}: source phrase ${JSON.stringify(phrase)} does not appear in the prompt — quote the prompt's own words exactly`);
    } else if (!valueTracesToPhrase(value, phrase)) {
      problems.push(`${path}: the value ${JSON.stringify(value)} cannot be read from the source phrase ${JSON.stringify(phrase)} — never invent a value; if the prompt doesn't state it, leave it out and ask in needs_input`);
    }
  }
  return problems;
}
