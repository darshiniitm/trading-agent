// Local search over the knowledge repository: label, id and alias lookup with whole-phrase matching,
// "sma6" / "6 day moving avg" tolerance and a small edit-distance for typos. In-memory — the catalogue is
// a few hundred strings; an SQLite/embedding index can replace this behind the same functions (P4).
import type { KbEntry, KbStatus } from "./schema";

export const norm = (s: string) =>
  s.toLowerCase().replace(/[-_/]+/g, " ").replace(/[^a-z0-9%. ]+/g, " ").replace(/\s+/g, " ").trim();

export type Hit = { entry: KbEntry; alias: string; score: number; how: "exact" | "phrase" | "partial" | "fuzzy" };
export type Index = { rows: { entry: KbEntry; alias: string; n: string }[] };

export function buildIndex(entries: KbEntry[], statuses: readonly KbStatus[] = ["reviewed"]): Index {
  const rows: Index["rows"] = [];
  for (const entry of entries) {
    if (!statuses.includes(entry.provenance.status)) continue;
    const names = new Set<string>([entry.id.replace(/_/g, " "), entry.label, ...entry.aliases, ...("phrases" in entry ? entry.phrases : [])]);
    for (const alias of names) { const n = norm(alias); if (n) rows.push({ entry, alias, n }); }
  }
  return { rows };
}

export function distance(a: string, b: string): number {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

const containsWords = (hay: string, needle: string) => ` ${hay} `.includes(` ${needle} `);

export function search(index: Index, phrase: string, opts: { kinds?: readonly KbEntry["kind"][]; limit?: number } = {}): Hit[] {
  const q = norm(phrase);
  if (!q) return [];
  // "sma6" -> also try "sma"
  const glued = /^([a-z]+)\d+$/.exec(q);
  const qs = glued ? [q, glued[1]] : [q];
  const best = new Map<string, Hit>();
  const put = (h: Hit) => { const k = h.entry.id + ":" + h.entry.kind; const o = best.get(k); if (!o || h.score > o.score) best.set(k, h); };
  for (const r of index.rows) {
    if (opts.kinds && !opts.kinds.includes(r.entry.kind)) continue;
    for (const s of qs) {
      if (r.n === s) put({ entry: r.entry, alias: r.alias, score: 1, how: "exact" });
      else if (containsWords(s, r.n)) put({ entry: r.entry, alias: r.alias, score: 0.8 + 0.1 * (r.n.length / s.length), how: "phrase" });
      else if (r.n.split(" ").length > 1 && s.split(" ").every((t) => containsWords(r.n, t))) put({ entry: r.entry, alias: r.alias, score: 0.6, how: "partial" });
      else {
        const limit = r.n.length >= 8 ? 2 : r.n.length >= 4 ? 1 : 0;
        const toks = s.split(" ");
        const d = Math.min(distance(r.n, s), ...toks.map((t) => distance(r.n, t)));
        if (limit > 0 && d <= limit) put({ entry: r.entry, alias: r.alias, score: 0.5 - 0.1 * d, how: "fuzzy" });
      }
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id)).slice(0, opts.limit ?? 5);
}

// The closest entries by name, for "not understood: <phrase>" — never a guess, only suggestions.
export function closest(index: Index, phrase: string, n = 3): KbEntry[] {
  const q = norm(phrase);
  const scored = new Map<string, { entry: KbEntry; d: number }>();
  for (const r of index.rows) {
    const d = Math.min(distance(r.n, q), ...q.split(" ").map((t) => distance(r.n, t)));
    const k = r.entry.kind + ":" + r.entry.id;
    if (!scored.has(k) || scored.get(k)!.d > d) scored.set(k, { entry: r.entry, d });
  }
  return [...scored.values()].sort((a, b) => a.d - b.d || a.entry.id.localeCompare(b.entry.id)).slice(0, n).map((x) => x.entry);
}

// Every entry named in free text (longest alias first, no overlaps) — for "recognised but not computable".
export function findMentions(index: Index, text: string, kinds?: readonly KbEntry["kind"][]): { entry: KbEntry; alias: string; index: number; end: number }[] {
  const t = text.toLowerCase();
  const rows = index.rows.filter((r) => !kinds || kinds.includes(r.entry.kind)).sort((a, b) => b.n.length - a.n.length);
  const taken: [number, number][] = [];
  const out: { entry: KbEntry; alias: string; index: number; end: number }[] = [];
  for (const r of rows) {
    const re = new RegExp(`(?<![a-z0-9])${r.alias.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[-_ ]+/g, "[-_ ]?")}(?![a-z0-9])`, "g");
    for (let m = re.exec(t); m; m = re.exec(t)) {
      const span: [number, number] = [m.index, m.index + m[0].length];
      if (taken.some(([a, b]) => span[0] < b && a < span[1])) continue;
      taken.push(span); out.push({ entry: r.entry, alias: r.alias, index: span[0], end: span[1] });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}
