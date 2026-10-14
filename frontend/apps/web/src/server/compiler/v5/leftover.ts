// What a line says that no recogniser turned into a rule. Two levels:
//   ask   the leftover holds a number, an indicator or a rule word -> worth one question to the local model;
//   flag  it holds a comparison word next to a subject ("above ... the cloud", "turned up through its signal line") ->
//         if nothing reads it, say so (the screen then reports partial matches) instead of silently ignoring it.
import { findMentions, indexOf, type Index } from "spec/src/kb";
import type { Clause } from "./segment";

// words that compare or time something. (A bare "breakout" / "squeeze" / "trend" is a strategy's name, not a comparison.)
const RULE = /\b(above|below|over|under|cross\w*|break(?:s|ing)?\s+(?:out\s+)?(?:above|below|over|under)|flip\w*|turn(?:ed|s|ing)|rising|falling|trending|within|at least|at most|between|exceed\w*|beat\w*|outperform\w*|higher|lower|gap\w*)\b/i;
// things a rule is about
const SUBJECT = /\b(price|close|closing|open|high|low|volume|signal|cloud|average|averages|moving average|ma|rsi|macd|adx|atr|ema|sma|dma|supertrend|vstop|bollinger|band|bands|width|momentum|return|turnover|range|kijun|tenkan)\b/i;
let idx: Index | null = null;

export type Leftover = { text: string; ask: boolean; flag: boolean };

export function leftoverOf(clause: Clause, used: boolean[], hasUnsupported = false): Leftover {
  if (hasUnsupported) return { text: "", ask: false, flag: false };   // already reported as "recognised but not computable"
  const t = clause.text.trim();
  // a title or an introduction to the lines below holds no rule of its own
  if (/^(build|create|make|write)\b[^.]*?(scanner|screener|strategy)\s*:?\s*$/i.test(t) || /:\s*$/.test(t)) return { text: "", ask: false, flag: false };
  const text = Array.from(clause.text, (ch, k) => (used[k] ? " " : ch)).join("").replace(/\s+/g, " ").trim();
  if (!text) return { text, ask: false, flag: false };
  idx ??= indexOf(["reviewed"]);
  const mentionsIndicator = findMentions(idx, text, ["indicator", "field"]).length > 0;
  const digits = /\d/.test(text);
  const rule = RULE.test(text);
  const subject = mentionsIndicator || SUBJECT.test(text);
  const ask = rule || (digits && subject);
  const flag = rule && (digits || subject);
  return { text, ask, flag };
}


/** Rule-sized pieces of a line, cut only at separators no recogniser used ("," ";" "and" "while" "with" "where" "that"):
 *  a small model reads one short phrase far better than a whole sentence. */
export function pieces(clause: Clause, used: boolean[]): { clause: Clause; used: boolean[] }[] {
  const cuts: [number, number][] = [];
  const sep = /,|;|\b(?:and|while|with|where|that|whose|but|having)\b/gi;
  for (let m = sep.exec(clause.text); m; m = sep.exec(clause.text)) {
    const a = m.index, b = a + m[0].length;
    if (!used.slice(a, b).some(Boolean)) cuts.push([a, b]);
  }
  const bounds: [number, number][] = [];
  let from = 0;
  for (const [a, b] of cuts) { bounds.push([from, a]); from = b; }
  bounds.push([from, clause.text.length]);
  return bounds.filter(([a, b]) => clause.text.slice(a, b).trim()).map(([a, b]) => ({
    clause: { ...clause, text: clause.text.slice(a, b), start: clause.start + a, end: clause.start + b },
    used: used.slice(a, b),
  }));
}
