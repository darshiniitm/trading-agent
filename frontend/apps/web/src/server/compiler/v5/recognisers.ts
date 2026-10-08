// Step 3 — rule-based recognisers. Each takes one clause and returns fragments with exact spans
// in the normalised text, or nothing. A clause no recogniser claims goes to the model fallback.
// Recognisers never invent a value: anything the clause doesn't state stays null and is turned
// into a question later (gap analysis).
import { INDICATORS } from "./registry";
import type { Clause } from "./segment";

export type Span = [number, number];
export type Tf = "1D" | "1W" | "1M";
export type Leaf = { path: string; phrase: string; span: Span };       // path is relative to the owning node
export type Need = { path: string; reason: "missing" | "placeholder" | "ambiguous" | "contradiction"; token?: string; phrase?: string; options?: { label: string; value: unknown }[] };

export type CondFrag = {
  kind: "condition";
  lhs: { field: string; params?: Record<string, unknown> } | { ind: string; params: Record<string, number | string | null>; tf: Tf | null };
  rhs?: { ind: string; params: Record<string, number | string | null>; tf: Tf | null } | null;
  op: string | null; value?: unknown; dir?: "long" | "short"; within_bars?: number | null; bars?: number;
  emit?: ("direction" | "event_date")[];
  phrase: string; span: Span; leaves: Leaf[]; needs: Need[];
};
export type UniverseFrag = { kind: "universe"; universe: { source: "nse_all" | "index" | "list"; index?: string; list?: string }; leaves: Leaf[] };
export type ScopeFrag = { kind: "scope"; tf: Tf; mode: "literal" | "latest"; phrase: string; span: Span };
export type NoiseFrag = { kind: "noise"; reason: string };
export type SetRef = { type: "none" } | { type: "qualified" } | { type: "number"; n: number } | { type: "description"; text: string; span: Span; stray?: string };
export type ActionFrag = {
  kind: "action"; action: "group_by" | "trade_plan" | "validate" | "rank" | "limit"; ref: SetRef; clauseSpan: Span;
  highlight?: boolean; hasSL?: boolean; hasEP?: boolean; hasConfidence?: boolean;
  shift?: Leaf | null; horizons?: { value: number[]; leaf: Leaf } | null;
  rankKey?: "event_date" | null; rankOrder?: "asc" | "desc"; n?: { value: number; leaf: Leaf };
};
// A line that only names series ("Calculate SMA 6 and SMA 30") and a line that only names an event
// ("Detect bullish and bearish crossovers") mean nothing alone; link.ts joins them into one condition.
export type SeriesFrag = { kind: "series"; mentions: SeriesMention[]; tf: Tf | null };
export type SeriesMention = { ind: string; params: Record<string, number | string | null>; leaves: Leaf[]; needs: Need[]; index: number; paramsEnd: number };
export type EventFrag = { kind: "event"; op: "cross_above" | "cross_below" | "cross_any"; within_bars: number | null; phrase: string; span: Span; leaves: Leaf[]; tf: Tf | null };
export type LinkFrag = { kind: "link"; note: string };
export type UnsupportedFrag = { kind: "unsupported"; text: string; reason: string };
export type Fragment = CondFrag | UniverseFrag | ScopeFrag | NoiseFrag | ActionFrag | LinkFrag | UnsupportedFrag;
export type RawFragment = Fragment | SeriesFrag | EventFrag;

const NUM = String.raw`\d[\d,]*(?:\.\d+)?`;
const AMT = String.raw`(${NUM})\s*(k|l)?`;                     // 10K, 10,000, 1L
const TOKEN = String.raw`\b[XYZNMxyznm]\b`;

export function amount(num: string, suffix?: string): number {
  const n = Number(num.replace(/,/g, ""));
  const s = (suffix ?? "").toLowerCase();
  return s === "k" ? n * 1000 : s === "l" ? n * 100000 : n;
}

const at = (c: Clause, i: number, len: number): Span => [c.start + i, c.start + i + len];
const leaf = (c: Clause, path: string, i: number, text: string): Leaf => ({ path, phrase: text, span: at(c, i, text.length) });

// ---------------------------------------------------------------- noise
export function noise(c: Clause): Fragment[] {
  const t = c.text.trim();
  // A title ("Build a Nifty 100 SMA crossover scanner:") is only noise when it names nothing we know
  // (R1): a universe or an indicator in it is content, read by the recognisers below.
  const title = /^(build|create|make|write)\s+(an?\s+)?[\w\s-]*?(scanner|screener|strategy)\s*:?\s*$/i.test(t);
  if (title && (INDEX_RE.test(t) || ALIASES.some(([, re]) => re.test(t)))) return [];
  if (/^(please\s+)?(read|use)\s+my\s+prompt\.?$/i.test(t) || /^(here is|this is) my (prompt|strategy)\b.*$/i.test(t) || title || /^[-=*#\s]+$/.test(t)) {
    return [{ kind: "noise", reason: "instruction to the assistant, not a screening rule" }];
  }
  // "Load them" / "Get these stocks": a back-reference to the universe named above (nothing to compute)
  if (/^(load|fetch|get|pull|use|take)\s+(them|these|those|the\s+(?:stocks|symbols|constituents|list))(?:\s+(?:now|first))?\.?$/i.test(t)) {
    return [{ kind: "noise", reason: "refers back to the universe named above" }];
  }
  return [];
}

// ---------------------------------------------------------------- universe
const INDEX_RE = /\bnifty\s*(midcap\s*150|midcap\s*100|smallcap\s*250|smallcap\s*100|next\s*50|\d{2,3})\b/i;
export function universe(c: Clause): Fragment[] {
  const m = INDEX_RE.exec(c.text);
  if (m) {
    const index = `NIFTY ${m[1].toUpperCase().replace(/\s+/g, " ")}`;
    const csv = /\b(csv|official list|nifty indices)\b/i.test(c.text);
    return [{ kind: "universe", universe: { source: "index", index, ...(csv ? { list: "niftyindices_csv" } : {}) },
             leaves: [leaf(c, "universe.index", m.index, m[0])] }];
  }
  const all = /\ball\s+(?:nse\s+)?(?:listed\s+)?stocks\b/i.exec(c.text);
  if (all) return [{ kind: "universe", universe: { source: "nse_all" }, leaves: [] }];
  return [];
}

// ---------------------------------------------------------------- market cap
const CMP: [RegExp, string][] = [
  [/^(below|under|less than|<)$/i, "<"], [/^(above|over|greater than|more than|>)$/i, ">"],
  [/^(at least|>=|minimum|min)$/i, ">="], [/^(at most|up to|<=|maximum|max)$/i, "<="],
];
const cmpOp = (w: string) => CMP.find(([re]) => re.test(w.trim()))?.[1] ?? null;
const CMP_WORDS = String.raw`below|under|less than|above|over|greater than|more than|at least|at most|up to|minimum|maximum|<=|>=|<|>`;
const CAP_CTX = /market\s*cap|\bmcap\b|\bcap\b|\bcr\b|\bcrores?\b/i;

export function mcap(c: Clause): Fragment[] {
  if (!CAP_CTX.test(c.text)) return [];
  const t = c.text;
  const unit = String.raw`(?:\s*(?:cr|crores?))?`;
  const range = new RegExp(String.raw`(?:(${CMP_WORDS}|between|from)\s+)?${AMT}${unit}\s*(?:-|to|and)\s*${AMT}${unit}`, "i").exec(t);
  const phraseEnd = (m: RegExpExecArray) => {
    const tail = /^\s*(?:cr|crores?)?(?:\s*market\s*cap)?/i.exec(t.slice(m.index + m[0].length));
    return m.index + m[0].length + (tail ? tail[0].length : 0);
  };
  if (range) {
    const [, word, n1, s1, n2, s2] = range;
    const lo = amount(n1, s1), hi = amount(n2, s2);
    const i1 = t.indexOf(n1 + (s1 ?? ""), range.index);
    const i2 = t.indexOf(n2 + (s2 ?? ""), i1 + n1.length);
    const tok1 = n1 + (s1 ?? ""), tok2 = n2 + (s2 ?? "");
    const leaves = [leaf(c, "value.0", i1, tok1), leaf(c, "value.1", i2, tok2)];
    const phrase = t.slice(range.index, phraseEnd(range));
    const cmp = word ? cmpOp(word) : null;
    const lhs = { field: "mcap_cr" };
    if (cmp) {
      // "below 10K-50K cr": a comparator AND a range. Never guess — options are built only from the user's own numbers.
      const fmt = (n: number) => n.toLocaleString("en-IN");
      return [{ kind: "condition", lhs, op: null, value: null, phrase, span: at(c, range.index, phrase.length), leaves: [],
        needs: [{ path: "op", reason: "contradiction", phrase: `${word} ${tok1}-${tok2}`.replace(/\s+/g, " "),
          options: [
            { label: `${cmp} ${fmt(lo)} cr`, value: { op: cmp, value: lo } },
            { label: `${cmp} ${fmt(hi)} cr`, value: { op: cmp, value: hi } },
            { label: `outside ${fmt(lo)}–${fmt(hi)} cr`, value: { op: "outside", value: [lo, hi] } },
          ] }] }];
    }
    return [{ kind: "condition", lhs, op: "between", value: [lo, hi], phrase, span: at(c, range.index, phrase.length), leaves, needs: [] }];
  }
  const single = new RegExp(String.raw`(${CMP_WORDS})\s+${AMT}${unit}`, "i").exec(t);
  if (single) {
    const [, word, n, s] = single;
    const tok = n + (s ?? "");
    const idx = t.indexOf(tok, single.index + word.length);
    const phrase = t.slice(single.index, phraseEnd(single));
    return [{ kind: "condition", lhs: { field: "mcap_cr" }, op: cmpOp(word), value: amount(n, s), phrase,
      span: at(c, single.index, phrase.length), leaves: [leaf(c, "value", idx, tok)], needs: [] }];
  }
  return [];
}

// ---------------------------------------------------------------- timeframe
export function timeframeOf(text: string): { tf: Tf; index: number; match: string } | null {
  const m = /\b(daily|weekly|monthly)\b(?:\s+(?:timeframe|candles?|chart|bars?|closing))?|\b(day|week|month)\s+candles?\b/i.exec(text);
  if (!m) return null;
  const w = (m[1] ?? m[2]).toLowerCase();
  return { tf: w.startsWith("d") ? "1D" : w.startsWith("w") ? "1W" : "1M", index: m.index, match: m[0] };
}

// ---------------------------------------------------------------- indicators
const ALIASES: [string, RegExp][] = [
  ["vstop", /\bv\s?-?stop\b/i], ["rsi", /\brsi\b/i], ["sma", /\bsma\b|\bsimple moving average\b/i],
  ["ema", /\bema\b|\bexponential moving average\b/i], ["atr", /\batr\b/i], ["macd", /\bmacd\b/i],
  ["supertrend", /\bsuper\s?-?trend\b/i], ["bollinger", /\bbollinger(?:\s+bands?)?\b/i], ["volume_avg", /\b(?:average|avg)\s+volume\b/i],
];

type Mention = { ind: string; index: number; end: number; params: Record<string, number | string | null>; leaves: Leaf[]; needs: Need[]; paramsEnd: number };

function mentions(c: Clause, bandFollows: (rest: string) => boolean): Mention[] {
  const found: { ind: string; index: number; end: number }[] = [];
  for (const [ind, re] of ALIASES) {
    const g = new RegExp(re.source, "gi");
    for (let m = g.exec(c.text); m; m = g.exec(c.text)) found.push({ ind, index: m.index, end: m.index + m[0].length });
  }
  found.sort((a, b) => a.index - b.index);
  return found.map((f, k) => {
    const reg = INDICATORS[f.ind];
    const params: Record<string, number | string | null> = Object.fromEntries(reg.required_params.map((p) => [p.name, null]));
    const leaves: Leaf[] = [], needs: Need[] = [];
    const rest = c.text.slice(f.end, found[k + 1]?.index ?? c.text.length);
    const arg = new RegExp(String.raw`^\s*[(\[]?\s*((?:${NUM}|${TOKEN})(?:\s*[,/ ]\s*(?:${NUM}|${TOKEN}))*)\s*[)\]]?`, "i").exec(rest);
    let paramsEnd = f.end;
    if (arg && !bandFollows(rest.slice(arg[0].length))) {
      const toks = arg[1].split(/\s*[,/ ]\s*/).filter(Boolean).slice(0, reg.positional_params.length);
      const startIdx = f.end + arg[0].indexOf(arg[1]);
      let cursor = 0;
      toks.forEach((tok, i) => {
        const name = reg.positional_params[i];
        const idx = startIdx + arg[1].indexOf(tok, cursor);
        cursor = arg[1].indexOf(tok, cursor) + tok.length;
        if (new RegExp(`^${TOKEN}$`).test(tok)) {
          needs.push({ path: `params.${name}`, reason: "placeholder", token: tok });
        } else {
          params[name] = Number(tok.replace(/,/g, ""));
          leaves.push(leaf(c, `params.${name}`, idx, tok));
        }
      });
      paramsEnd = startIdx + arg[1].length;
    }
    return { ind: f.ind, index: f.index, end: f.end, params, leaves, needs, paramsEnd };
  });
}

const BAND_CONNECT = String.raw`(?:to|and|-)`;
function bandAfter(rest: string): boolean {
  return new RegExp(String.raw`^\s*${BAND_CONNECT}\s*(?:${NUM}|${TOKEN})`, "i").test(rest);
}

function parseBand(c: Clause, from: number): { lo: number | null; hi: number | null; leaves: Leaf[]; needs: Need[]; end: number } | null {
  const t = c.text.slice(from);
  const re = new RegExp(String.raw`(?:range|between|from)?\s*(${NUM}|${TOKEN})\s*${BAND_CONNECT}\s*(${NUM}|${TOKEN})`, "i");
  const m = re.exec(t);
  if (!m) return null;
  const leaves: Leaf[] = [], needs: Need[] = [];
  const side = (tok: string, i: number, idx: number): number | null => {
    if (new RegExp(`^${TOKEN}$`).test(tok)) { needs.push({ path: `value.${i}`, reason: "placeholder", token: tok }); return null; }
    leaves.push(leaf(c, `value.${i}`, from + idx, tok));
    return Number(tok.replace(/,/g, ""));
  };
  const i1 = m.index + m[0].indexOf(m[1]);
  const i2 = m.index + m[0].lastIndexOf(m[2]);
  return { lo: side(m[1], 0, i1), hi: side(m[2], 1, i2), leaves, needs, end: from + m.index + m[0].length };
}

const SCALAR = new RegExp(String.raw`(${CMP_WORDS})\s*(${NUM})`, "i");

const crossOp = (text: string): "cross_above" | "cross_below" | "cross_any" => {
  const bull = /\bbullish|\babove\b|\bup\b/i.test(text), bear = /\bbearish|\bbelow\b|\bdown\b/i.test(text);
  return bull && !bear ? "cross_above" : bear && !bull ? "cross_below" : "cross_any";
};

export function indicators(c: Clause): RawFragment[] {
  const t = c.text;
  const flip = /\bflip(?:s|ped)?\b|\bturn(?:s|ed)?\s+(?:long|bullish|up)\b/i.exec(t);
  const cross = /\bcross(?:es|ed|ing|over|overs)?\b/i.exec(t);
  const isCross = !!cross;
  const ms = mentions(c, (rest) => !isCross && bandAfter(rest));
  const tfm = timeframeOf(t);
  const tf: Tf | null = tfm?.tf ?? null;
  if (ms.length === 0) {
    // "Detect bullish and bearish crossovers": an event with no series of its own — link.ts finds them (R2)
    if (!cross) return [];
    const mod = /\b(?:bullish|bearish)\b(?:\s+and\s+(?:bullish|bearish)\b)?\s*/i.exec(t.slice(0, cross.index + cross[0].length));
    const start = mod && mod.index < cross.index ? mod.index : cross.index;
    const end = cross.index + cross[0].length;
    const wb = /\b(?:in|within)\s+the\s+last\s+(\d+)\s+(?:bars?|days?|weeks?|candles?)\b/i.exec(t);
    const phrase = t.slice(start, end);
    const leaves = wb ? [leaf(c, "within_bars", wb.index + wb[0].indexOf(wb[1]), wb[1])] : [];
    return [{ kind: "event", op: crossOp(t), within_bars: wb ? Number(wb[1]) : null, phrase, span: at(c, start, phrase.length), leaves, tf }];
  }

  // a cross needs two series; one named here ("an SMA crossover scanner") is a title, not a condition
  if (isCross && ms.length < 2) return [];
  if (isCross && ms.length >= 2) {
    const [a, b] = ms;
    const text = t.toLowerCase();
    const bull = /\bbullish|\babove\b|\bup\b/.test(text), bear = /\bbearish|\bbelow\b|\bdown\b/.test(text);
    const op = bull && !bear ? "cross_above" : bear && !bull ? "cross_below" : "cross_any";
    const end = Math.max(cross!.index + cross![0].length, b?.paramsEnd ?? a.paramsEnd);
    const phrase = t.slice(a.index, end);
    const wb = /\b(?:in|within)\s+the\s+last\s+(\d+)\s+(?:bars?|days?|weeks?|candles?)\b/i.exec(t);
    const leaves = [...a.leaves, ...(b?.leaves.map((l) => ({ ...l, path: `rhs.${l.path}` })) ?? [])];
    const needs: Need[] = [...a.needs, ...(b?.needs.map((n) => ({ ...n, path: `rhs.${n.path}` })) ?? [])];
    if (wb) leaves.push(leaf(c, "within_bars", wb.index + wb[0].indexOf(wb[1]), wb[1]));
    return [{
      kind: "condition", lhs: { ind: a.ind, params: a.params, tf }, rhs: b ? { ind: b.ind, params: b.params, tf } : null,
      op, within_bars: wb ? Number(wb[1]) : null, emit: op === "cross_any" ? ["direction", "event_date"] : ["event_date"],
      phrase, span: at(c, a.index, phrase.length), leaves, needs: b ? needs : [...needs, { path: "rhs", reason: "missing" }],
    }];
  }

  // one condition per indicator mention (a line may carry both an event and a band, e.g. "VStop 10,2 flip and RSI 50-65")
  const out: Fragment[] = [];
  ms.forEach((m, k) => {
    const limit = ms[k + 1]?.index ?? t.length;
    const seg: Clause = { ...c, text: t.slice(0, limit) };
    const base = { phrase: "", span: [0, 0] as Span, leaves: [...m.leaves], needs: [...m.needs] };
    const reg = INDICATORS[m.ind];
    const lhs = { ind: m.ind, params: m.params, tf };
    if (flip && flip.index < limit && reg.events.includes("flip") && (flip.index > m.index - 40)) {
      const short = /\b(short|bearish|down)\b/i.test(t.slice(Math.max(0, flip.index - 12), flip.index + flip[0].length + 14));
      const start = Math.min(flip.index, m.index), end = Math.max(flip.index + flip[0].length, m.paramsEnd);
      const phrase = t.slice(start, end);
      out.push({ kind: "condition", lhs, op: "flip", dir: short ? "short" : "long", within_bars: 1,
        ...base, phrase, span: at(c, start, phrase.length) });
      return;
    }
    const band = parseBand(seg, m.paramsEnd);
    if (band) {
      const phrase = t.slice(m.index, band.end);
      out.push({ kind: "condition", lhs, op: "between", value: [band.lo, band.hi], ...base,
        leaves: [...m.leaves, ...band.leaves], needs: [...m.needs, ...band.needs], phrase, span: at(c, m.index, phrase.length) });
      return;
    }
    const sc = SCALAR.exec(t.slice(m.paramsEnd, limit));
    if (sc) {
      const idxTok = m.paramsEnd + sc.index + sc[0].lastIndexOf(sc[2]);
      const phrase = t.slice(m.index, m.paramsEnd + sc.index + sc[0].length);
      out.push({ kind: "condition", lhs, op: cmpOp(sc[1]), value: Number(sc[2].replace(/,/g, "")), ...base,
        leaves: [...m.leaves, leaf(c, "value", idxTok, sc[2])], phrase, span: at(c, m.index, phrase.length) });
      return;
    }
    // an indicator named with nothing to test is not a condition by itself
  });
  if (out.length === 0) {
    return [{ kind: "series", tf, mentions: ms.map((m) => ({ ind: m.ind, params: m.params, leaves: m.leaves, needs: m.needs, index: m.index, paramsEnd: m.paramsEnd })) }];
  }
  return out;
}

// ---------------------------------------------------------------- scope (standalone timeframe line)
export function scope(c: Clause): Fragment[] {
  const tfm = timeframeOf(c.text);
  if (!tfm) return [];
  if (ALIASES.some(([, re]) => re.test(c.text)) || CAP_CTX.test(c.text) || /\b(group|build|backtest|validate|rank)\b/i.test(c.text)) return [];
  return [{ kind: "scope", tf: tfm.tf, mode: tfm.tf === "1D" ? "latest" : "literal", phrase: c.text, span: [c.start, c.end] }];
}

// ---------------------------------------------------------------- actions
function refOf(c: Clause): SetRef {
  const t = c.text;
  const num = /\bfrom\s+(?:step\s+|stocks?\s+(?:in\s+)?|(?:the\s+)?(?:stocks?\s+)?(?:of|in)\s+(?:step\s+)?)?(\d{1,2})\b/i.exec(t);
  if (num) return { type: "number", n: Number(num[1]) };
  const desc = /^from\s+(?:the\s+)?(?:stocks?\s+)?(.+?)(\s+in)?\s+(?:build|create|make|generate|group|show|give|plan)\b/i.exec(t);
  if (desc) {
    const text = desc[1].trim();
    const idx = t.indexOf(text);
    return { type: "description", text, span: at(c, idx, text.length), ...(desc[2] ? { stray: "in" } : {}) };
  }
  if (/\bqualified\b/i.test(t)) return { type: "qualified" };
  return { type: "none" };
}

export function actions(c: Clause): Fragment[] {
  const t = c.text;
  const span: Span = [c.start, c.end];
  if (/\b(back-?test|validate|validation)\b/i.test(t)) {
    const sh = /\b(?:previous|last|prior)\s+week\b/i.exec(t);
    const multi = /\b(\d)\s*(?:,|-|and)\s*(\d)\s*(?:,|-|and)?\s*(\d)?\s*weeks?\b/i.exec(t);
    // a lone "this week" / "next week" names no horizon of its own: the user's saved horizons apply (assumed)
    let horizons: ActionFrag["horizons"] = null;
    if (multi) {
      const vals = [multi[1], multi[2], multi[3]].filter(Boolean).map(Number);
      horizons = { value: vals, leaf: leaf(c, "horizons_w", multi.index, multi[0]) };
    }
    return [{ kind: "action", action: "validate", ref: { type: "none" }, clauseSpan: span,
      shift: sh ? leaf(c, "shift.weeks", sh.index, sh[0]) : null, horizons }];
  }
  if (/\bgroup\b.*\bsectors?\b/i.test(t)) {
    return [{ kind: "action", action: "group_by", ref: refOf(c), clauseSpan: span, highlight: /\b(highlight|outperform\w*)\b/i.test(t) }];
  }
  if (/\b(SL|stop.?loss|EP|entry point|confidence|trade plan)\b/i.test(t) || /\b(build|create|make)\b.*\bstrategy\b/i.test(t)) {
    return [{ kind: "action", action: "trade_plan", ref: refOf(c), clauseSpan: span,
      hasSL: /\bSL\b|stop.?loss/i.test(t), hasEP: /\bEP\b|entry point/i.test(t), hasConfidence: /\bconfidence\b/i.test(t) }];
  }
  const lim = /\btop\s+(\d+)\b/i.exec(t);
  if (/\b(rank(?:ed|ing)?|sort(?:ed)?|order(?:ed)?\s+by)\b/i.test(t)) {
    const recent = /\b(most recent|latest|newest|recent)\b/i.test(t), oldest = /\b(oldest|earliest)\b/i.test(t);
    const key = /\b(cross\w*|date|flip\w*)\b/i.test(t) && (recent || oldest) ? "event_date" : null;
    const frags: Fragment[] = [{ kind: "action", action: "rank", ref: refOf(c), clauseSpan: span, rankKey: key, rankOrder: oldest ? "asc" : "desc" }];
    if (lim) frags.push({ kind: "action", action: "limit", ref: refOf(c), clauseSpan: span, n: { value: Number(lim[1]), leaf: leaf(c, "n", lim.index + 4, lim[1]) } });
    return frags;
  }
  if (lim) return [{ kind: "action", action: "limit", ref: refOf(c), clauseSpan: span, n: { value: Number(lim[1]), leaf: leaf(c, "n", lim.index + lim[0].indexOf(lim[1]), lim[1]) } }];
  return [];
}

// ---------------------------------------------------------------- clause dispatcher
export const RECOGNISER_NAMES = ["noise", "actions", "scope", "universe+mcap", "indicators"] as const;

export function recognise(c: Clause, disabled: ReadonlySet<string> = new Set()): RawFragment[] {
  const on = (n: string) => !disabled.has(n);
  if (on("noise")) { const f = noise(c); if (f.length) return f; }
  if (on("actions")) { const f = actions(c); if (f.length) return f; }   // an action clause never also creates conditions
  if (on("scope")) { const f = scope(c); if (f.length) return f; }
  const out: RawFragment[] = [];
  if (on("universe+mcap")) out.push(...universe(c), ...mcap(c));
  if (on("indicators") && !out.some((f) => f.kind === "condition")) out.push(...indicators(c));
  return out;
}
