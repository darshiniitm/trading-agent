// Cross-line linking (docs/prompt-agent-interpreter-plan.md R2/R4). Procedural prompts state a crossover
// in two lines — "Calculate SMA 6 and SMA 30", then "Detect bullish and bearish crossovers" — and neither
// means anything alone. This pass joins an event line to the nearest earlier series line that names at
// least two series, producing the ordinary cross condition the assembler already understands. Pure
// and deterministic; nothing is invented: every value still comes from the series line's own spans.
import type { Clause } from "./segment";
import type { CondFrag, EventFrag, Fragment, RawFragment, SeriesFrag } from "./recognisers";
import type { ClauseResult } from "./assemble";

export type RawResult = { clause: Clause; fragments: RawFragment[]; viaModel?: boolean };

const isSeries = (f: RawFragment): f is SeriesFrag => f.kind === "series";
const isEvent = (f: RawFragment): f is EventFrag => f.kind === "event";

export function linkClauses(raw: RawResult[]): ClauseResult[] {
  const used = new Set<string>();   // clause ids of series lines already joined to an event
  const out: ClauseResult[] = raw.map((r) => ({ ...r, fragments: r.fragments.filter((f): f is Fragment => !isSeries(f) && !isEvent(f)) }));

  raw.forEach((r, i) => {
    const ev = r.fragments.find(isEvent);
    if (!ev) return;
    // nearest earlier series line with two or more series that nothing else has claimed
    for (let j = i - 1; j >= 0; j--) {
      const s = raw[j].fragments.find(isSeries);
      if (!s || s.mentions.length < 2 || used.has(raw[j].clause.id)) continue;
      const [a, b] = s.mentions;
      const tf = ev.tf ?? s.tf;
      const cond: CondFrag = {
        kind: "condition",
        lhs: { ind: a.ind, params: a.params, tf }, rhs: { ind: b.ind, params: b.params, tf },
        op: ev.op, within_bars: ev.within_bars, emit: ev.op === "cross_any" ? ["direction", "event_date"] : ["event_date"],
        phrase: ev.phrase, span: ev.span,
        // the series values keep the spans of the line they were written on
        leaves: [...a.leaves, ...b.leaves.map((l) => ({ ...l, path: `rhs.${l.path}` })), ...ev.leaves],
        needs: [...a.needs, ...b.needs.map((n) => ({ ...n, path: `rhs.${n.path}` }))],
      };
      out[i].fragments.push(cond);
      out[j].fragments.push({ kind: "link", note: `series for the crossover on line ${raw[i].clause.id}` });
      used.add(raw[j].clause.id);
      return;
    }
    // no series to join: stays "not understood" (empty fragments), never guessed
  });

  // series lines nobody used: say so instead of leaving them unexplained
  raw.forEach((r, i) => {
    if (r.fragments.some(isSeries) && !used.has(r.clause.id) && out[i].fragments.length === 0) {
      out[i].fragments.push({ kind: "noise", reason: "indicators named with nothing to test" });
    }
  });
  return out;
}
