// Trader-phrase recognisers (the layer between the line-level recognisers and the model).
//
// A pattern reads a whole phrase ("price above the 150 and 200 day SMA", "9 EMA crossing above 21 EMA in the last 3
// sessions", "within 25% of the 52-week high", "volume at least 2 times the 20-day average") and emits finished
// conditions, each with the exact span it came from. Every number the prompt states keeps its own leaf (traceable);
// every value the phrase only IMPLIES (a 252-session year, a x1.30 multiple, the daily timeframe, an indicator's
// standard length) is listed in `implied` and shown to the user as an editable assumption — never filled silently.
//
// Matching works on a working copy of the clause in which each moving-average mention is replaced by a placeholder
// character run of the same length, so offsets stay valid and phrases can be written as ordinary regexes.
import type { Clause } from "./segment";
import type { ActionFrag, CondFrag, Fragment, Implied, Leaf, Span, Tf } from "./recognisers";

const MA = "\u0001";
const NUM = String.raw`\d+(?:\.\d+)?`;
const ABOVE = String.raw`(?:above|over|greater than|more than|higher than|exceeds?)`;
const BELOW = String.raw`(?:below|under|less than|lower than)`;
const SESSIONS = String.raw`(?:trading\s+)?(?:sessions?|days?|bars?|candles?|weeks?)`;
const WORDNUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, twice: 2, double: 2, thrice: 3 };

type Ind = { ind: string; params: Record<string, number | string | null>; tf: Tf | null; output?: string };
type Group = { kind: "sma" | "ema"; tf: Tf | null; items: { len: number; idx: number; tok: string }[]; start: number; end: number; word: string };

export type PatternResult = { frags: Fragment[]; masked: string; claimsActions: boolean; used: boolean[] };

const tfOfWord = (w: string | undefined): Tf | null => (!w ? null : /^(day|days|d|dma)$/i.test(w) ? "1D" : /^(week|weeks|wk|w)$/i.test(w) ? "1W" : null);

/** A single timeframe stated anywhere in the clause ("weekly chart", "daily"), else null (none, or both). */
export function clauseTimeframe(text: string): Tf | null {
  const w = /\bweekly\b|\bweek(?:ly)? (?:chart|candles?|close)\b/i.test(text);
  const d = /\b(?:daily|dma|sessions?|today|tomorrow|yesterday|next\s+(?:day|open)|\d+[-\s]?days?|connors|rsi\s*\(?\s*[23]\s*\)?|[23][-\s]?period\s+rsi)\b/i.test(text);
  return w && !d ? "1W" : d && !w ? "1D" : null;
}

export function patterns(c: Clause): PatternResult {
  const text = c.text;
  const used = new Array<boolean>(text.length).fill(false);
  let w = text;
  const out: Fragment[] = [];
  let claimsActions = false;
  const cTf = clauseTimeframe(text);

  const at = (i: number, len: number): Span => [c.start + i, c.start + i + len];
  const leaf = (path: string, i: number, tok: string): Leaf => ({ path, phrase: tok, span: at(i, tok.length) });
  const free = (i: number, j: number) => { for (let k = i; k < j; k++) if (used[k]) return false; return true; };
  const take = (i: number, j: number) => {
    for (let k = i; k < j; k++) used[k] = true;
    w = w.slice(0, i) + " ".repeat(j - i) + w.slice(j);
  };

  // ---- moving-average mentions -> placeholder runs
  const groups = new Map<number, Group>();
  const maRe = new RegExp(String.raw`(\d+(?:[-\s]?(?:days?|weeks?))?(?:\s*(?:,|and|&)\s*\d+(?:[-\s]?(?:days?|weeks?))?)*)[-\s]*(days?|weeks?|wk|d|w|period)?[-\s]*(sma|ema|dma|wma|moving\s+averages?|mas?)s?\b`, "gi");
  for (let m = maRe.exec(text); m; m = maRe.exec(text)) {
    if (/nifty\s*(?:midcap\s*|smallcap\s*|next\s*)?$/i.test(text.slice(0, m.index))) continue;   // "Nifty 100 SMA crossover": 100 is the index
    const kindWord = m[3].toLowerCase().replace(/s$/, "");
    const items: Group["items"] = [];
    const base = m.index;
    for (const nm of m[1].matchAll(/\d+/g)) items.push({ len: Number(nm[0]), idx: base + nm.index!, tok: nm[0] });
    const tf = kindWord === "dma" ? "1D" : kindWord === "wma" ? "1W" : tfOfWord(m[2]) ?? tfOfWord(/(day|week)s?\s*$/i.exec(m[1])?.[1]);
    groups.set(base, { kind: kindWord === "ema" ? "ema" : "sma", tf, items, start: base, end: base + m[0].length, word: m[0] });
    w = w.slice(0, base) + MA.repeat(m[0].length) + w.slice(base + m[0].length);
  }
  // prefix style "EMA 9" / "SMA(200)" (the number after the name)
  const preRe = /\b(sma|ema|dma)\s*(?:\(\s*(\d+)\s*\)|(\d+))/gi;
  for (let m = preRe.exec(text); m; m = preRe.exec(text)) {
    if (!free(m.index, m.index + m[0].length) || [...groups.values()].some((g) => m!.index < g.end && g.start < m!.index + m[0].length)) continue;
    const num = m[2] ?? m[3], base = m.index + m[0].indexOf(num, m[1].length);
    groups.set(m.index, { kind: m[1].toLowerCase() === "ema" ? "ema" : "sma", tf: m[1].toLowerCase() === "dma" ? "1D" : null, items: [{ len: Number(num), idx: base, tok: num }], start: m.index, end: m.index + m[0].length, word: m[0] });
    w = w.slice(0, m.index) + MA.repeat(m[0].length) + w.slice(m.index + m[0].length);
  }
  const groupAt = (idx: number): Group | undefined => groups.get(idx);

  // ---- builders
  const maOperand = (g: Group, k: number, tf: Tf | null): Ind => ({ ind: g.kind, params: { length: g.items[k].len, source: "close" }, tf });
  const maLeaves = (g: Group, k: number, role: "lhs" | "rhs"): Leaf[] =>
    [leaf(`${role === "rhs" ? "rhs." : ""}params.length`, g.items[k].idx, g.items[k].tok)];
  const bar = (src: string, tf: Tf | null): Ind => ({ ind: "bar", params: { source: src }, tf });
  // A timeframe the phrase (or the clause) states is used as written. Inherently-daily setups (MACD, Ichimoku, NR7 ...) fall
  // back to daily as a visible assumption; the rest stay undecided so a scope line / the user's default settles them.
  const tfImplied = (tf: Tf | null, fallback: Tf | null): { tf: Tf | null; imp: Implied[] } =>
    tf ? { tf, imp: [] } : fallback ? { tf: fallback, imp: [{ path: "tf", label: "timeframe (none stated: daily bars)" }] } : { tf: null, imp: [] };
  const impSource = (role: "" | "rhs." = ""): Implied => ({ path: `${role}params.source`, label: "price source: close" });

  /** The right-hand operand repeats the left's own parameters (MACD line vs its signal line): same words, same assumptions. */
  const dup = <T extends { path: string }>(xs: T[]): T[] => [...xs, ...xs.filter((x) => x.path.startsWith("params.")).map((x) => ({ ...x, path: `rhs.${x.path}` }))];

  type Spec = {
    lhs: Ind; op: string; rhs?: Ind | null; value?: unknown; within_bars?: number | null; dir?: "long" | "short";
    rhs_mult?: number; emit?: ("direction" | "event_date")[]; i: number; j: number; leaves?: Leaf[]; implied?: Implied[];
  };
  const cond = (s: Spec): CondFrag => ({
    kind: "condition", lhs: s.lhs, ...(s.rhs !== undefined ? { rhs: s.rhs } : {}), op: s.op,
    ...(s.value !== undefined ? { value: s.value } : {}), ...(s.within_bars !== undefined ? { within_bars: s.within_bars } : {}),
    ...(s.dir ? { dir: s.dir } : {}), ...(s.rhs_mult !== undefined ? { rhs_mult: s.rhs_mult } : {}), ...(s.emit ? { emit: s.emit } : {}),
    phrase: text.slice(s.i, s.j), span: at(s.i, s.j - s.i), leaves: s.leaves ?? [], needs: [], ...(s.implied?.length ? { implied: s.implied } : {}),
  });

  /** Run `re` over the working text; for each match whose characters are still free, let `fn` build conditions. */
  const scan = (re: RegExp, fn: (m: RegExpExecArray) => Fragment[] | null) => {
    const flags = re.flags.replace(/[gd]/g, "") + "gd";
    const g = new RegExp(re.source, flags);
    for (let m = g.exec(w); m; m = g.exec(w)) {
      const i = m.index, j = i + m[0].length;
      if (!free(i, j)) continue;
      const r = fn(m);
      if (r && r.length) { out.push(...r); take(i, j); }
    }
  };
  const grp = (m: RegExpExecArray, name: number): Group | undefined => {
    const span = (m as RegExpExecArray & { indices?: ([number, number] | undefined)[] }).indices?.[name];
    return span ? groupAt(span[0]) : undefined;
  };
  /** Every moving-average group inside capture `name` (the "and 200 DMA" tail of "above the 150 DMA and 200 DMA"). */
  const tailGroups = (m: RegExpExecArray, name: number): Group[] => {
    const span = (m as RegExpExecArray & { indices?: ([number, number] | undefined)[] }).indices?.[name];
    if (!span) return [];
    const out: Group[] = [];
    for (const r of m[name].matchAll(/\u0001+/g)) { const g = groupAt(span[0] + r.index!); if (g) out.push(g); }
    return out;
  };
  const idxOf = (m: RegExpExecArray, s: string, from = 0) => m.index + m[0].indexOf(s, from);
  const windowOf = (m: RegExpExecArray, gi: number, ui: number, leafAt: number): { n: number | null; leaves: Leaf[] } => {
    const s = m[gi];
    if (!s) return { n: null, leaves: [] };
    return { n: Number(s), leaves: [leaf("within_bars", leafAt, s)] };
  };

  // named strategies: the name itself is a title, the rules follow in the sentence ("Minervini's trend template: ...")
  for (const re of [/\b(?:mark\s+)?minervini(?:'s)?\s+(?:trend\s+)?template\b/i, /\b(?:stan\s+)?weinstein(?:'s)?\s+stage\s*2(?:\s+breakout)?\b/i,
    /\b(?:larry\s+)?connors(?:'s)?(?:\s+rsi\s*\(?2\)?)?(?:\s+(?:strategy|pullback))?\b/i, /\b(?:toby\s+)?crabel\b/i, /\bbollinger\s+band\s+squeeze\s+breakout\b/i]) {
    const nm = re.exec(w);
    if (nm && free(nm.index, nm.index + nm[0].length)) take(nm.index, nm.index + nm[0].length);
  }
  // an exit sentence is not part of the screen
  scan(/\bexit\s+when\b[^.]*\.?/i, (m) => [{ kind: "noise", reason: "exit rule: the screen lists today's candidates; exits are applied by the trader afterwards" }]);

  // ======================================================== crosses
  // "<MA> crossed/crossing above <MA> in the last N sessions"
  scan(new RegExp(String.raw`(${MA}+)\s+(?:has\s+|have\s+)?(?:cross(?:es|ed|ing)?|mov(?:es|ed|ing)|turn(?:s|ed|ing))\s+(?:back\s+)?(?:up\s+)?(above|below|over|under|through)\s+(?:the\s+)?(${MA}+)(?:\s+(?:(?:in|within|over|during)\s+(?:the\s+)?(?:last|past)|within)\s+(\d+)\s+${SESSIONS})?`, "i"), (m) => {
    const a = grp(m, 1), b = grp(m, 3);
    if (!a || !b) return null;
    const up = /^(above|over|through)$/i.test(m[2]);
    const { tf, imp } = tfImplied(a.tf ?? b.tf ?? cTf, null);
    const i = m.index, j = i + m[0].length;
    const wi = m[4] ? idxOf(m, m[4], m[0].indexOf(m[3]) + m[3].length) : -1;
    const within = m[4] ? Number(m[4]) : 1;
    const lv = [...maLeaves(a, 0, "lhs"), ...maLeaves(b, 0, "rhs"), ...(m[4] ? [leaf("within_bars", wi, m[4])] : [])];
    const implied: Implied[] = [...imp, impSource(), impSource("rhs.")];
    if (!m[4]) implied.push({ path: "within_bars", label: "crossed in the last bar (no window stated)" });
    const lhs = maOperand(a, 0, tf), rhs = maOperand(b, 0, tf);
    return [
      cond({ lhs, rhs, op: up ? "cross_above" : "cross_below", within_bars: within, emit: ["event_date"], i, j, leaves: lv, implied }),
      // "crossed above ... and is still above": the reading every golden-cross screen uses
      cond({ lhs: maOperand(a, 0, tf), rhs: maOperand(b, 0, tf), op: up ? ">" : "<", i, j, leaves: [...maLeaves(a, 0, "lhs"), ...maLeaves(b, 0, "rhs")],
        implied: [...imp, impSource(), impSource("rhs.")] }),
    ];
  });

  // MACD (12,26,9) bullish crossover [below the zero line] [in the last N sessions] -- the zero-line and window phrases may
  // come before or after the crossover words ("... crossover in the last 2 days while MACD is below zero")
  scan(new RegExp(String.raw`macd\s*(?:\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)|(\d+)\s*,\s*(\d+)\s*,\s*(\d+))?\s*(?:line\s+)?(bullish|bearish)?\s*(?:cross(?:over|es|ed|ing)?|turn(?:ed|s|ing)?\s+up(?:\s+through)?)(?:\s+(?:above|over|below|under|through)\s+(?:the\s+|its\s+)?(?:signal|zero)(?:\s+line)?)?`, "i"), (m) => {
    const i = m.index, j = i + m[0].length;
    const bull = !/^bearish$/i.test(m[7] ?? "");
    const { tf, imp } = tfImplied(cTf, "1D");
    const nums = [m[1] ?? m[4], m[2] ?? m[5], m[3] ?? m[6]];
    const P: Record<string, number | string | null> = { fast: nums[0] ? Number(nums[0]) : 12, slow: nums[1] ? Number(nums[1]) : 26, signal: nums[2] ? Number(nums[2]) : 9, source: "close" };
    const lv: Leaf[] = [];
    if (nums[0]) { let cur = m[0].search(/\d/) + m.index; (["fast", "slow", "signal"] as const).forEach((nm, k) => { const ix = m.input.indexOf(nums[k]!, cur); lv.push(leaf(`params.${nm}`, ix, nums[k]!)); cur = ix + nums[k]!.length; }); }
    const implied: Implied[] = [...imp, { path: "params.source", label: "MACD price source: close" }];
    if (!nums[0]) implied.push({ path: "params.fast", label: "MACD standard settings 12/26/9" }, { path: "params.slow", label: "MACD standard settings 12/26/9" }, { path: "params.signal", label: "MACD standard settings 12/26/9" });
    // the window and the zero line, wherever the sentence puts them (outside this match, still unused)
    const rest = (s: string, from: number, to: number) => w.slice(from, to).search(new RegExp(s, "i")) ;
    const winRe = new RegExp(String.raw`(?:(?:in|within|over|during)\s+(?:the\s+)?(?:last|past)|within)\s+(\d+)\s+${SESSIONS}`, "ig");
    let win: RegExpExecArray | null = null;
    for (let x = winRe.exec(w); x; x = winRe.exec(w)) if (free(x.index, x.index + x[0].length)) { win = x; break; }
    const zeroRe = /(?:(?:while|and|with|but)\s+)?(?:macd\s+(?:line\s+)?(?:is\s+)?|the\s+)?(?:(above|below)\s+(?:the\s+)?zero(?:\s+line)?|(?:(?:still|remains?|stays?|is)\s+)+(negative|positive))/ig;
    let zero: RegExpExecArray | null = null;
    for (let x = zeroRe.exec(w); x; x = zeroRe.exec(w)) if (free(x.index, x.index + x[0].length)) { zero = x; break; }
    const inMatchZero = /(above|over|below|under)\s+(?:the\s+|its\s+)?zero/i.exec(m[0]);
    void rest;
    const wnd = win ? Number(win[1]) : 1;
    const wl = win ? [leaf("within_bars", win.index + win[0].search(/\d/), win[1])] : [];
    const L = (out: string): Ind => ({ ind: "macd", params: { ...P }, tf, output: out });
    const frags: CondFrag[] = [cond({ lhs: L("value"), rhs: L("signal"), op: bull ? "cross_above" : "cross_below", within_bars: wnd, emit: ["event_date"], i, j, leaves: [...dup(lv), ...wl], implied: [...dup(implied), ...(win ? [] : [{ path: "within_bars", label: "crossed in the last bar (no window stated)" }])] })];
    // still on the right side of the signal line today
    frags.push(cond({ lhs: L("value"), rhs: L("signal"), op: bull ? ">" : "<", i, j, leaves: dup(lv), implied: dup(implied) }));
    const z = zero ?? (inMatchZero ? ({ 1: inMatchZero[1], index: m[0].indexOf(inMatchZero[0]) + i, 0: inMatchZero[0] } as unknown as RegExpExecArray) : null);
    if (z) frags.push(cond({ lhs: L("value"), op: /^(below|under|negative)$/i.test(z[1] ?? z[2] ?? "") ? "<" : ">", value: 0, i, j, leaves: [...lv], implied: [...implied, { path: "value", label: "the zero line = 0" }] }));
    if (win) take(win.index, win.index + win[0].length);
    if (zero) take(zero.index, zero.index + zero[0].length);
    return frags;
  });

  // Ichimoku: Tenkan-sen crossed above Kijun-sen [in the last N sessions]
  const ich = (out: string, tf: Tf | null): Ind => ({ ind: "ichimoku", params: { tenkan: 9, kijun: 26, span_b: 52, shift: 26 }, tf, output: out });
  const ichImplied = (): Implied[] => ["tenkan", "kijun", "span_b", "shift"].map((p) => ({ path: `params.${p}`, label: "Ichimoku standard settings 9/26/52/26" }));
  scan(new RegExp(String.raw`tenkan(?:[-\s]?sen)?\s+(?:has\s+)?cross(?:es|ed|ing)\s+(above|below)\s+kijun(?:[-\s]?sen)?(?:\s+(?:(?:in|within|during)\s+(?:the\s+)?(?:last|past)|within)\s+(\d+)\s+${SESSIONS})?`, "i"), (m) => {
    const i = m.index, j = i + m[0].length, up = /^above$/i.test(m[1]);
    const { tf, imp } = tfImplied(cTf, "1D");
    const wl = m[2] ? [leaf("within_bars", m.input.indexOf(m[2], m.index + m[0].lastIndexOf(m[2]) - 1), m[2])] : [];
    const implied = [...imp, ...dup(ichImplied()), ...(m[2] ? [] : [{ path: "within_bars", label: "crossed in the last bar (no window stated)" }])];
    return [
      cond({ lhs: ich("tenkan", tf), rhs: ich("kijun", tf), op: up ? "cross_above" : "cross_below", within_bars: m[2] ? Number(m[2]) : 1, emit: ["event_date"], i, j, leaves: wl, implied }),
      cond({ lhs: ich("tenkan", tf), rhs: ich("kijun", tf), op: up ? ">" : "<", i, j, implied: [...imp, ...dup(ichImplied())] }),
    ];
  });
  scan(new RegExp(String.raw`(?:price|close|closing price)\s+(?:is\s+)?(above|below|over|under)\s+the\s+(?:ichimoku\s+)?cloud`, "i"), (m) => {
    const i = m.index, j = i + m[0].length, up = /^(above|over)$/i.test(m[1]);
    const { tf, imp } = tfImplied(cTf, "1D");
    return [cond({ lhs: bar("close", tf), rhs: ich(up ? "cloud_top" : "cloud_bottom", tf), op: up ? ">" : "<", i, j,
      implied: [...imp, { path: "params.source", label: "price = the close" }, ...ichImplied().map((x) => ({ ...x, path: `rhs.${x.path}` }))] })];
  });

  // Supertrend (10,3) turned green in the last N days
  scan(new RegExp(String.raw`super\s?-?trend\s*\(?\s*(\d+)\s*[,\s]\s*(${NUM})\s*\)?\s*(?:has\s+)?(?:just\s+)?(?:(?:turned|turns|turning|flipped|flips|flipping)(?:\s+to)?\s+(green|bullish|up|red|bearish|down)|gives?\s+(?:a\s+)?(buy|sell)\s+signal|(buy|sell)\s+signal)(?:\s*\(?\s*(?:(?:(?:in|within|during)\s+)?(?:the\s+)?(?:last|past)|within)\s+(\d+)\s+${SESSIONS}\s*\)?)?`, "i"), (m) => {
    const i = m.index, j = i + m[0].length;
    const long = /^(green|bullish|up|buy)$/i.test(m[3] ?? m[4] ?? m[5]);
    const { tf, imp } = tfImplied(cTf, "1D");
    const l1 = m.input.indexOf(m[1], m.index + 10), l2 = m.input.indexOf(m[2], l1 + m[1].length);
    const wl = m[6] ? [leaf("within_bars", m.input.indexOf(m[6], m.index + m[0].lastIndexOf(m[6]) - 1), m[6])] : [];
    return [cond({ lhs: { ind: "supertrend", params: { length: Number(m[1]), mult: Number(m[2]) }, tf }, op: "flip", dir: long ? "long" : "short", within_bars: m[6] ? Number(m[6]) : 1,
      emit: ["event_date"], i, j, leaves: [leaf("params.length", l1, m[1]), leaf("params.mult", l2, m[2]), ...wl], implied: [...imp, ...(m[6] ? [] : [{ path: "within_bars", label: "flipped on the last bar (no window stated)" }])] })];
  });

  // RSI has just crossed back above 30 (last 3 sessions)
  scan(new RegExp(String.raw`rsi\s*\(?\s*(\d+)?\s*\)?\s+(?:has\s+)?(?:just\s+)?(?:crossed|moved|came|popped|turned|rose|climbed)(?:\s+back)?(?:\s+up)?\s+(above|over|below|under)\s+(${NUM})(?:\s*\(?\s*(?:in\s+(?:the\s+)?)?(?:last|past)\s+(\d+)\s+${SESSIONS}\s*\)?)?`, "i"), (m) => {
    const i = m.index, j = i + m[0].length, up = /^(above|over)$/i.test(m[2]);
    const { tf, imp } = tfImplied(cTf, null);
    const lv: Leaf[] = [];
    const lenImp: Implied[] = [];  // (an unstated RSI length stays open: the interpreter fills the standard 14 and shows it)
    if (m[1]) lv.push(leaf("params.length", m.input.indexOf(m[1], m.index + 3), m[1]));
    const lvl = m.input.indexOf(m[3], m.index + m[0].indexOf(m[2]) + m[2].length);
    const rsi: Ind = { ind: "rsi", params: { length: m[1] ? Number(m[1]) : null }, tf };
    const wl = m[4] ? [leaf("within_bars", m.input.indexOf(m[4], m.index + m[0].lastIndexOf(m[4]) - 1), m[4])] : [];
    return [
      cond({ lhs: rsi, op: up ? "cross_above" : "cross_below", value: Number(m[3]), within_bars: m[4] ? Number(m[4]) : 1, emit: ["event_date"], i, j,
        leaves: [...lv, leaf("value", lvl, m[3]), ...wl], implied: [...imp, ...lenImp, ...(m[4] ? [] : [{ path: "within_bars", label: "crossed on the last bar (no window stated)" }])] }),
      cond({ lhs: { ...rsi, params: { ...rsi.params } }, op: up ? ">" : "<", value: Number(m[3]), i, j, leaves: [...lv, leaf("value", lvl, m[3])], implied: [...imp, ...lenImp] }),
    ];
  });

  // ======================================================== 52-week highs / lows
  const WK52 = String.raw`52[-\s]?(?:week|wk)`;
  const hiLo = (kind: "high_n" | "low_n", skip: number, tf: Tf | null): Ind => ({ ind: kind, params: { lookback: 252, skip }, tf });
  const yearImplied = (role: "" | "rhs.", skip: number, why: string): Implied[] =>
    [{ path: `${role}params.lookback`, label: `52 weeks = 252 trading sessions` }, { path: `${role}params.skip`, label: why || (skip ? "excluding today's bar" : "including today's bar") }];

  // within X% of the 52-week high / low
  scan(new RegExp(String.raw`within\s+(${NUM})\s*%\s+of\s+(?:the\s+|their\s+|its\s+)?${WK52}\s+(high|low)`, "i"), (m) => {
    const i = m.index, j = i + m[0].length, p = Number(m[1]), isHigh = /^high$/i.test(m[2]);
    const { tf, imp } = tfImplied(cTf, null);
    const lv = [leaf("rhs_mult", m.input.indexOf(m[1], m.index), m[1])];
    void lv;
    return [cond({ lhs: bar("close", tf), op: isHigh ? ">=" : "<=", rhs: hiLo(isHigh ? "high_n" : "low_n", 0, tf), rhs_mult: isHigh ? 1 - p / 100 : 1 + p / 100, i, j,
      implied: [...imp, { path: "params.source", label: "price = the close" }, ...yearImplied("rhs.", 0, ""), { path: "rhs_mult", label: `within ${p}% = x${isHigh ? 1 - p / 100 : 1 + p / 100}` }] })];
  });
  // near the 52-week low (within 10%)
  scan(new RegExp(String.raw`near\s+(?:the\s+|their\s+|its\s+)?${WK52}\s+(high|low)\s*\(\s*within\s+(${NUM})\s*%\s*\)`, "i"), (m) => {
    const i = m.index, j = i + m[0].length, p = Number(m[2]), isHigh = /^high$/i.test(m[1]);
    const { tf, imp } = tfImplied(cTf, null);
    return [cond({ lhs: bar("close", tf), op: isHigh ? ">=" : "<=", rhs: hiLo(isHigh ? "high_n" : "low_n", 0, tf), rhs_mult: isHigh ? 1 - p / 100 : 1 + p / 100, i, j,
      implied: [...imp, { path: "params.source", label: "price = the close" }, ...yearImplied("rhs.", 0, ""), { path: "rhs_mult", label: `within ${p}% = x${isHigh ? 1 - p / 100 : 1 + p / 100}` }] })];
  });
  // at least X% above the 52-week low
  scan(new RegExp(String.raw`(?:at\s+least\s+)?(${NUM})\s*%\s+above\s+(?:the\s+|their\s+|its\s+)?${WK52}\s+low`, "i"), (m) => {
    const i = m.index, j = i + m[0].length, p = Number(m[1]);
    const { tf, imp } = tfImplied(cTf, null);
    return [cond({ lhs: bar("close", tf), op: ">=", rhs: hiLo("low_n", 0, tf), rhs_mult: 1 + p / 100, i, j,
      implied: [...imp, { path: "params.source", label: "price = the close" }, ...yearImplied("rhs.", 0, ""), { path: "rhs_mult", label: `${p}% above = x${1 + p / 100}` }] })];
  });
  // closing at a new 52-week high
  scan(new RegExp(String.raw`(?:(?:(?:closing|closes?|making|hitting|at)\s+(?:at\s+)?)?(?:a\s+)?(?:new|fresh)|(?:hit(?:ting|s)?|reach(?:ing|es)?|touch(?:ing|es)?|mak(?:ing|es)|print(?:ing|s)?|breakouts?\s+to|break(?:s|ing)?\s+out\s+to|clos(?:ed|es|ing)\s+at|trad(?:es|ing)\s+at)\s+(?:a\s+)?)\s*${WK52}\s+high`, "i"), (m) => {
    const i = m.index, j = i + m[0].length;
    const { tf, imp } = tfImplied(cTf, null);
    return [cond({ lhs: bar("close", tf), op: ">", rhs: hiLo("high_n", 1, tf), i, j,
      implied: [...imp, { path: "params.source", label: "price = the close" }, ...yearImplied("rhs.", 1, "new high = above the previous 252 sessions' high (today excluded)")] })];
  });
  // breaking above the 26-week high
  scan(new RegExp(String.raw`break(?:ing|s)?\s+(?:out\s+)?(?:above|over)\s+(?:the\s+)?(\d+)[-\s]?(week|wk|day)s?\s+high`, "i"), (m) => {
    const i = m.index, j = i + m[0].length, tf: Tf = /^day$/i.test(m[2]) ? "1D" : "1W";
    const l = m.input.indexOf(m[1], m.index);
    return [cond({ lhs: bar("close", tf), op: ">", rhs: { ind: "high_n", params: { lookback: Number(m[1]), skip: 1 }, tf }, i, j, leaves: [leaf("rhs.params.lookback", l, m[1])],
      implied: [{ path: "params.source", label: "price = the close" }, { path: "rhs.params.skip", label: "breakout = above the previous bars' high (current bar excluded)" }] })];
  });

  // ======================================================== volume multiples
  const volOp = (mult: number, lenTok: string | undefined, lenIdx: number, unit: string | undefined, i: number, j: number, multTok: string | undefined, multIdx: number): CondFrag => {
    const tf: Tf | null = unit && /^wee?k/i.test(unit) ? "1W" : unit ? "1D" : cTf;
    const lv: Leaf[] = [];
    const implied: Implied[] = [{ path: "params.source", label: "volume" }, { path: "rhs.params.skip", label: "average of the previous bars (today excluded)" }];
    if (multTok && multIdx >= 0) lv.push(leaf("rhs_mult", multIdx, multTok)); else implied.push({ path: "rhs_mult", label: `volume at least ${mult}x its average` });
    const rhs: Ind = { ind: "volume_avg", params: { length: lenTok ? Number(lenTok) : 20, skip: 1 }, tf };
    if (lenTok) lv.push(leaf("rhs.params.length", lenIdx, lenTok)); else implied.push({ path: "rhs.params.length", label: "average volume over 20 bars" });
    return cond({ lhs: bar("volume", tf), op: ">=", rhs, rhs_mult: mult, i, j, leaves: lv.filter((l) => l.path !== "rhs_mult"), implied: implied.concat(lv.some((l) => l.path === "rhs_mult") ? [{ path: "rhs_mult", label: `volume at least ${mult}x its average (as written)` }] : []) });
  };
  scan(new RegExp(String.raw`(?:with\s+|on\s+)?volume\s+(?:is\s+|of\s+)?(?:(?:at\s+least|>=|above|over)\s+)?(${NUM}|twice|double|thrice)\s*(?:x|×|times)?\s*(?:the\s+)?(?:(\d+)[-\s]?(day|week|wk)s?\s+)?average(?:\s+volume)?`, "i"), (m) => {
    const mult = WORDNUM[m[1].toLowerCase()] ?? Number(m[1]);
    const li = m[2] ? m.input.indexOf(m[2], m.index + m[0].indexOf(m[1]) + m[1].length) : -1;
    return [volOp(mult, m[2], li, m[3], m.index, m.index + m[0].length, undefined, -1)];
  });
  scan(new RegExp(String.raw`(?:on|with)\s+(?:at\s+least\s+)?(${NUM}|twice|double)\s*(?:x|×|times|the)\s*(?:the\s+)?(?:(\d+)[-\s]?(day|week|wk)s?\s+)?average\s+volume`, "i"), (m) => {
    const mult = WORDNUM[m[1].toLowerCase()] ?? Number(m[1]);
    const li = m[2] ? m.input.indexOf(m[2], m.index + m[0].indexOf(m[1]) + m[1].length) : -1;
    return [volOp(mult, m[2], li, m[3], m.index, m.index + m[0].length, undefined, -1)];
  });

  // ======================================================== price action
  scan(new RegExp(String.raw`gap(?:ped|ping|s)?[-\s]?up\s+(?:of\s+|by\s+|at\s+least\s+)?(${NUM})\s*%(?:\s+or\s+more)?\s+(?:above|over)\s+(?:yesterday'?s|the\s+previous|previous)\s+high`, "i"), (m) => {
    const i = m.index, j = i + m[0].length, p = Number(m[1]);
    const { tf, imp } = tfImplied(cTf, "1D");
    return [cond({ lhs: { ind: "gap_up", params: {}, tf }, op: ">=", value: p / 100, i, j, implied: [...imp, { path: "value", label: `${p}% gap = ${p / 100} of yesterday's high` }] })];
  });
  scan(new RegExp(String.raw`(?:closed|closes|closing|close)\s+(?:is\s+)?(?:above|over)\s+(?:the\s+|its\s+|their\s+)?open`, "i"), (m) => {
    const { tf, imp } = tfImplied(cTf, "1D");
    return [cond({ lhs: bar("close", tf), op: ">", rhs: bar("open", tf), i: m.index, j: m.index + m[0].length, implied: [...imp, { path: "params.source", label: "the close" }, { path: "rhs.params.source", label: "the open" }] })];
  });
  scan(/\bNR(\d+)\b/i, (m) => {
    const { tf, imp } = tfImplied(cTf, "1D");
    return [cond({ lhs: { ind: "narrow_range", params: { length: Number(m[1]) }, tf }, op: "==", value: 1, i: m.index, j: m.index + m[0].length,
      leaves: [leaf("params.length", m.index + 2, m[1])], implied: [...imp, { path: "value", label: "NR7 = today's range is the narrowest of the last 7 bars" }] })];
  });
  scan(/\binside\s+(?:day|bar)\b/i, (m) => {
    const { tf, imp } = tfImplied(cTf, "1D");
    return [cond({ lhs: { ind: "inside_day", params: {}, tf }, op: "==", value: 1, i: m.index, j: m.index + m[0].length, implied: [...imp, { path: "value", label: "inside day = high below and low above yesterday's" }] })];
  });
  // Bollinger squeeze
  scan(new RegExp(String.raw`band\s*width\s+(?:at|hit|reached|touched|is\s+at)\s+(?:a\s+)?(\d+)[-\s]?month\s+low\s+(?:(?:in|within|during)\s+(?:the\s+)?(?:last|past)|within)\s+(\d+)\s+${SESSIONS}`, "i"), (m) => {
    const i = m.index, j = i + m[0].length;
    const { tf, imp } = tfImplied(cTf, "1D");
    const wl = leaf("params.within", m.input.indexOf(m[2], m.index + m[0].lastIndexOf(m[2]) - 1), m[2]);
    return [cond({ lhs: { ind: "bb_squeeze", params: { length: 20, mult: 2, lookback: Number(m[1]) * 21, within: Number(m[2]) }, tf }, op: "==", value: 1, i, j, leaves: [wl],
      implied: [...imp, { path: "params.length", label: "Bollinger standard settings 20/2" }, { path: "params.mult", label: "Bollinger standard settings 20/2" },
        { path: "params.lookback", label: `${m[1]} months = ${Number(m[1]) * 21} trading sessions` }, { path: "value", label: "1 = bandwidth was at its low within the window" }] })];
  });
  scan(new RegExp(String.raw`(\d+)[-\s]?month\s+low\s+in\s+(?:the\s+)?band\s*width\s+(?:(?:in|within|during)\s+(?:the\s+)?(?:last|past)|within)\s+(\d+)\s+${SESSIONS}`, "i"), (m) => {
    const i = m.index, j = i + m[0].length;
    const { tf, imp } = tfImplied(cTf, "1D");
    const wl = leaf("params.within", m.input.indexOf(m[2], m.index + m[0].lastIndexOf(m[2]) - 1), m[2]);
    return [cond({ lhs: { ind: "bb_squeeze", params: { length: 20, mult: 2, lookback: Number(m[1]) * 21, within: Number(m[2]) }, tf }, op: "==", value: 1, i, j, leaves: [wl],
      implied: [...imp, { path: "params.length", label: "Bollinger standard settings 20/2" }, { path: "params.mult", label: "Bollinger standard settings 20/2" },
        { path: "params.lookback", label: `${m[1]} months = ${Number(m[1]) * 21} trading sessions` }, { path: "value", label: "1 = bandwidth was at its low within the window" }] })];
  });
  scan(new RegExp(String.raw`(?:today'?s\s+)?(?:close|price)\s+(?:is\s+)?above\s+the\s+upper\s+(?:bollinger\s+)?band`, "i"), (m) => {
    const { tf, imp } = tfImplied(cTf, "1D");
    return [cond({ lhs: bar("close", tf), op: ">", rhs: { ind: "bollinger", params: { length: 20, mult: 2, source: "close" }, tf, output: "upper" }, i: m.index, j: m.index + m[0].length,
      implied: [...imp, { path: "params.source", label: "the close" }, { path: "rhs.params.length", label: "Bollinger standard settings 20/2" }, { path: "rhs.params.mult", label: "Bollinger standard settings 20/2" }, { path: "rhs.params.source", label: "the close" }] })];
  });

  // ======================================================== price / MA relations
  // "<MA> trending up (for at least N months)" / "rising 30-week"
  scan(new RegExp(String.raw`(${MA}+)\s+(?:is\s+|stays\s+)?(?:trending\s+up|rising)(?:\s+for\s+(?:at\s+least\s+)?(\d+|a|one)\s+(month|week|day)s?(?:\s+or\s+more)?)?`, "i"), (m) => {
    const g = grp(m, 1); if (!g) return null;
    const i = m.index, j = i + m[0].length;
    const { tf, imp } = tfImplied(g.tf ?? cTf, null);
    const n = m[2] && /^\d+$/.test(m[2]) ? Number(m[2]) : 1, unit = (m[3] ?? "month").toLowerCase();
    const perUnit = unit === "month" ? 21 : unit === "week" ? 5 : 1;
    return [cond({ lhs: maOperand(g, 0, tf), op: "up_over", i, j, leaves: maLeaves(g, 0, "lhs"),
      implied: [...imp, impSource(), { path: "bars", label: m[2] ? `${n} ${unit}${n > 1 ? "s" : ""} = ${n * perUnit} trading sessions` : "rising over the last month (21 sessions)" }] })].map((f) => ({ ...f, bars: n * perUnit }));
  });
  // "<price> above/below [a rising] <MA group> [and <MA group> ...]"  (also 'stocks above the 20 and 50 EMA')
  const TAIL = String.raw`((?:\s+(?:and|&)\s+(?:both\s+)?(?:the\s+|a\s+)?${MA}+)*)`;
  scan(new RegExp(String.raw`(?:(weekly\s+)?(?:price|close|closing price)\s+(?:is\s+|closes?\s+)?|\bstocks?\s+(?:that\s+are\s+|which\s+are\s+|trading\s+)?|(?<=[-–:,]\s))(above|below|over|under)\s+(?:both\s+)?(?:the\s+|a\s+)?(rising\s+)?(${MA}+)${TAIL}`, "i"), (m) => {
    const g = grp(m, 4); if (!g) return null;
    const all = [g, ...tailGroups(m, 5)];
    const up = /^(above|over)$/i.test(m[2]);
    const i = m.index, j = i + m[0].length;
    const frags: Fragment[] = [];
    for (const gg of all) {
      const { tf, imp } = tfImplied(gg.tf ?? g.tf ?? (m[1] ? "1W" : cTf), null);
      gg.items.forEach((_, k) => {
        frags.push(cond({ lhs: bar("close", tf), op: up ? ">" : "<", rhs: maOperand(gg, k, tf), i, j, leaves: maLeaves(gg, k, "rhs"),
          implied: [...imp, { path: "params.source", label: "price = the close" }, impSource("rhs.")] }));
        if (m[3]) frags.push({ ...cond({ lhs: maOperand(gg, k, tf), op: "up_over", i, j, leaves: maLeaves(gg, k, "lhs"), implied: [...imp, impSource(), { path: "bars", label: "rising = higher than 4 bars ago" }] }), bars: 4 });
      });
    }
    return frags;
  });
  // "<MA group> above/below [both] <MA group> [and <MA group>]"
  scan(new RegExp(String.raw`(${MA}+)\s+(?:is\s+|stays\s+)?(above|below|over|under)\s+(?:both\s+)?(?:the\s+)?(${MA}+)${TAIL}`, "i"), (m) => {
    const a = grp(m, 1), b = grp(m, 3); if (!a || !b) return null;
    const up = /^(above|over)$/i.test(m[2]);
    const i = m.index, j = i + m[0].length;
    const frags: Fragment[] = [];
    for (const bb of [b, ...tailGroups(m, 4)]) {
      const { tf, imp } = tfImplied(a.tf ?? bb.tf ?? cTf, null);
      bb.items.forEach((_, k) => frags.push(cond({ lhs: maOperand(a, 0, tf), op: up ? ">" : "<", rhs: maOperand(bb, k, tf), i, j,
        leaves: [...maLeaves(a, 0, "lhs"), ...maLeaves(bb, k, "rhs")], implied: [...imp, impSource(), impSource("rhs.")] })));
    }
    return frags;
  });

  // ======================================================== plain English
  scan(new RegExp(String.raw`pulling\s+back\s+to\s+(?:the\s+)?(${MA}+)`, "i"), (m) => {
    const g = grp(m, 1); if (!g) return null;
    const i = m.index, j = i + m[0].length;
    const { tf, imp } = tfImplied(g.tf ?? cTf, "1D");
    const L = maLeaves(g, 0, "rhs");
    return [
      cond({ lhs: bar("close", tf), op: ">=", rhs: maOperand(g, 0, tf), i, j, leaves: L, implied: [...imp, { path: "params.source", label: "price = the close" }, impSource("rhs.")] }),
      cond({ lhs: bar("close", tf), op: "<=", rhs: maOperand(g, 0, tf), rhs_mult: 1.02, i, j, leaves: L,
        implied: [...imp, { path: "params.source", label: "price = the close" }, impSource("rhs."), { path: "rhs_mult", label: "pulling back to = within 2% above the average" }] }),
    ];
  });
  scan(/\bin\s+a\s+strong\s+(?:up)?trend\b|\bstrong\s+(?:up)?trend\b/i, (m) => {
    const i = m.index, j = i + m[0].length;
    const { tf, imp } = tfImplied(cTf, "1D");
    const e = (n: number): Ind => ({ ind: "ema", params: { length: n, source: "close" }, tf });
    const why = (r: "" | "rhs."): Implied[] => [{ path: `${r}params.length`, label: "strong uptrend = EMA 20 > EMA 50 > EMA 200" }, impSource(r)];
    return [
      cond({ lhs: e(20), op: ">", rhs: e(50), i, j, implied: [...imp, ...why(""), ...why("rhs.")] }),
      cond({ lhs: e(50), op: ">", rhs: e(200), i, j, implied: [...imp, ...why(""), ...why("rhs.")] }),
    ];
  });
  // RS rating
  scan(new RegExp(String.raw`rs\s+rating\s+(?:of\s+)?(${NUM})(?:\s*\+|\s+or\s+(?:more|above|higher))?`, "i"), (m) => {
    const i = m.index, j = i + m[0].length;
    return [cond({ lhs: { field: "rs_rating", params: { lookback: 252 } } as any, op: ">=", value: Number(m[1]), i, j, leaves: [leaf("value", m.input.indexOf(m[1], m.index), m[1])],
      implied: [{ path: "params.lookback", label: "RS rating = percentile of the 12-month (252-session) return within the universe" }] })];
  });
  // average daily turnover above N cr
  scan(new RegExp(String.raw`(?:average|avg)\s+daily\s+turnover\s+(?:of\s+)?(?:is\s+)?(${ABOVE}|${BELOW}|at\s+least|at\s+most)\s+(?:rs\.?\s*)?(${NUM})\s*(?:cr|crores?)?`, "i"), (m) => {
    const i = m.index, j = i + m[0].length;
    const cmp = /^(above|over|greater|more|higher|exceed)/i.test(m[1]) ? ">" : /^at\s+least/i.test(m[1]) ? ">=" : /^at\s+most/i.test(m[1]) ? "<=" : "<";
    const nv = m.input.indexOf(m[2], m.index + m[0].indexOf(m[1]) + m[1].length);
    return [cond({ lhs: { ind: "turnover_avg", params: { length: 20 }, tf: "1D" }, op: cmp, value: Number(m[2]), i, j, leaves: [leaf("value", nv, m[2])],
      implied: [{ path: "params.length", label: "average over the last 20 sessions" }] })];
  });
  // level comparisons: "2-period RSI below 10", "RSI above 55", "ADX is above 25", "weekly RSI above 60"
  scan(new RegExp(String.raw`(?:(weekly|daily)\s+)?(?:(\d+)[-\s]?(?:period|day|bar)\s+)?(rsi|adx)(?:\s*\(?\s*(\d+)\s*\)?)?\s+(?:value\s+)?(?:is\s+|stays\s+)?(${ABOVE}|${BELOW}|at\s+least|at\s+most|>=|<=|>|<)\s*(${NUM})`, "i"), (m) => {
    const i = m.index, j = i + m[0].length;
    const ind = m[3].toLowerCase();
    const cmp = /^(above|over|greater|more|higher|exceed|>)$/i.test(m[5].trim().split(/\s+/)[0]) && m[5] !== ">=" ? ">" : m[5] === ">=" || /^at\s+least/i.test(m[5]) ? ">=" : m[5] === "<=" || /^at\s+most/i.test(m[5]) ? "<=" : "<";
    const tf = (m[1] ? (/^weekly$/i.test(m[1]) ? "1W" : "1D") : cTf) as Tf | null;
    const { tf: tf2, imp } = tfImplied(tf, null);
    const lenTok = m[2] ?? m[4];
    const lv: Leaf[] = [];
    const implied: Implied[] = [...imp];
    if (lenTok) lv.push(leaf("params.length", m.input.indexOf(lenTok, m.index + (m[1] ? m[1].length : 0)), lenTok));
    const vi = m.input.indexOf(m[6], m.index + m[0].length - m[6].length - 1);
    lv.push(leaf("value", vi, m[6]));
    return [cond({ lhs: { ind, params: { length: lenTok ? Number(lenTok) : null }, tf: tf2 }, op: cmp, value: Number(m[6]), i, j, leaves: lv, implied })];
  });

  // ======================================================== actions
  // rank by 12-month return excluding the most recent month ("12-1 momentum"), top N
  // (a pasted formula such as "(day n price - day0 price)*100/day0_price" may sit between "return" and "excluding")
  const momRe = /\b(\d+)\s*-\s*1\s+momentum\b|\b(\d+)[-\s]?months?\s+returns?(?:\s*\([^()]*\)(?:\s*[*/x]\s*[\w.]+)*)?\s+(?:excluding|skipping|ex|without)\s+the\s+(?:most\s+recent|last|latest|recent)\s+month\b/gi;
  const moms: RegExpExecArray[] = [];
  for (let x = momRe.exec(w); x; x = momRe.exec(w)) if (free(x.index, x.index + x[0].length)) moms.push(x);
  if (moms.length && /\b(?:rank(?:ed)?|sort(?:ed)?|top|best)\b/i.test(w)) {
    const first = moms[0], months = Number(first[1] ?? first[2]);
    const by = /\bby\s+(?:their\s+)?$/i.exec(w.slice(0, first.index));
    const i = first.index - (by ? by[0].length : 0), j = first.index + first[0].length;
    const top = /\b(?:top|best)\s+(\d+)\b/i.exec(w);
    const lookback = months * 21;
    out.push(cond({ lhs: { ind: "momentum_skip", params: { lookback, skip: 21 }, tf: "1D" }, op: ">", value: -100, i, j,
      implied: [{ path: "params.lookback", label: `${months} months = ${lookback} trading sessions` }, { path: "params.skip", label: "excluding the most recent month = skip 21 sessions" }, { path: "value", label: "ranking only: no cut-off" }] }));
    for (const x of moms) take(x.index - (x === first && by ? by[0].length : 0), x.index + x[0].length);
    const span: Span = [c.start, c.end];
    out.push({ kind: "action", action: "rank", ref: { type: "qualified" }, clauseSpan: span, rankKey: "value", rankOrder: "desc" } as ActionFrag);
    if (top) { out.push({ kind: "action", action: "limit", ref: { type: "qualified" }, clauseSpan: span, n: { value: Number(top[1]), leaf: leaf("n", top.index + top[0].indexOf(top[1]), top[1]) } }); take(top.index, top.index + top[0].length); }
    claimsActions = true;
  }
  // which sectors outperformed over the last N weeks? top K stocks in each
  const sr = new RegExp(String.raw`sectors?\s+.*?(?:(?:out)?(?:perform\w*|beat\w*)|did\s+better\s+than|better\s+than|ahead\s+of|outpac\w*)\s+(?:the\s+)?(?:index|benchmark|market|nifty\s*\d*)\s+(?:over|in|during)\s+(?:the\s+)?(?:last|past)\s+(\d+)\s+weeks?`, "i").exec(w);
  if (sr && free(sr.index, sr.index + sr[0].length)) {
    const j = sr.index + sr[0].length, i = sr.index + sr[0].search(/(?:(?:out)?(?:perform|beat)|did\s+better|better\s+than|ahead\s+of|outpac)/i);   // keep "in the Nifty 500" for the universe
    const top = /\btop\s+(\d+)\s+stocks?\s+(?:(?:in|of|from)\s+(?:each|every)|per|for\s+each)(?:\s+sector)?/i.exec(w);
    out.push(cond({ lhs: bar("close", "1D"), op: ">", value: 0, i, j, implied: [{ path: "params.source", label: "the close" }, { path: "value", label: "no stock filter: every stock in the universe is grouped" }] }));
    take(i, j);
    const lookback = Number(sr[1]) * 5;
    out.push({ kind: "action", action: "group_by", ref: { type: "qualified" }, clauseSpan: [c.start, c.end], highlight: false,
      preset: { key: "sector", highlight: { metric: "ew_sector_return_vs_universe", lookback_sessions: lookback, ...(top ? { top_n_per_group: Number(top[1]) } : {}), rule: {} } },
      implied: [{ path: "highlight.lookback_sessions", label: `${sr[1]} weeks = ${lookback} trading sessions`, value: lookback }] } as ActionFrag);
    if (top) take(top.index, top.index + top[0].length);
    claimsActions = true;
  }
  // trade plan: entry at next day's open, stop loss N ATR below entry, target NR
  const ep = /\b(?:entry|enter|buy)\s+(?:at\s+)?(?:the\s+)?next\s+(?:day'?s?\s+|session'?s?\s+)?open\b/i.exec(w);
  const sl = new RegExp(String.raw`(?:stop(?:\s*loss)?\s+(${NUM})\s*ATR|(${NUM})\s*ATR\s+stop(?:\s*loss)?)\s+(?:below|under)\s+(?:the\s+)?entry`, "i").exec(w);
  const tg = new RegExp(String.raw`(?:target\s+(${NUM})\s*R\b|(${NUM})\s*R\s+target)`, "i").exec(w);
  if (ep && sl) {
    const preset: Record<string, unknown> = { entry: { at: "next_open" }, stop: { from_atr: { length: 14, mult: Number(sl[1] ?? sl[2]), tf: "1D" } } };
    if (tg) preset.target = { r_multiple: Number(tg[1] ?? tg[2]) };
    out.push({ kind: "action", action: "trade_plan", ref: { type: "qualified" }, clauseSpan: [c.start, c.end], preset,
      implied: [{ path: "stop.from_atr.length", label: "ATR standard length 14", value: 14 }] } as ActionFrag);
    for (const mm of [ep, sl, tg]) if (mm && free(mm.index, mm.index + mm[0].length)) take(mm.index, mm.index + mm[0].length);
    claimsActions = true;
  }

  // conditions in the order the prompt states them (patterns are tried in a fixed order, not text order)
  const pos = (f: Fragment) => (f.kind === "condition" ? f.span[0] : f.kind === "action" ? f.clauseSpan[0] + 1e6 : -1);
  const sorted = out.map((f, k) => ({ f, k })).sort((a, b) => pos(a.f) - pos(b.f) || a.k - b.k).map((x) => x.f);
  const masked = Array.from(text, (ch, k) => (used[k] ? " " : ch)).join("");   // unconsumed placeholders go back to the original words
  return { frags: sorted, masked, claimsActions, used };
}
