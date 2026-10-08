// Step 1 of the interpreter pipeline (docs/prompt-agent-interpreter-plan.md §3): tools only, no model.
// Tags every span the deterministic tools already know — numbers, money, timeframes, knowledge-repository
// aliases, operator phrases — so the Reader is shown what is certain and never has to re-find it.
import { findMentions, indexOf, type Index } from "spec/src/kb";
import { amount, timeframeOf, type Span } from "./recognisers";
import type { Clause } from "./segment";

export type Annotation =
  | { type: "number"; text: string; value: number; span: Span }
  | { type: "timeframe"; text: string; value: "1D" | "1W" | "1M"; span: Span }
  | { type: "kb"; kind: string; id: string; text: string; span: Span; computable: boolean }
  | { type: "operator"; text: string; op: string; span: Span };

let idx: Index | null = null;
const NUM = /(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(?:k|l)?(?![a-z0-9])/gi;

export function preannotate(norm: string, clauses: Clause[]): Annotation[] {
  idx ??= indexOf(["reviewed", "proposed"]);
  const out: Annotation[] = [];
  for (const c of clauses) {
    for (let m = NUM.exec(c.text); m; m = NUM.exec(c.text)) {
      const mm = /^((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(k|l)?$/i.exec(m[0].trim());
      if (mm) out.push({ type: "number", text: m[0].trim(), value: amount(mm[1], mm[2]), span: [c.start + m.index, c.start + m.index + m[0].trim().length] });
    }
    NUM.lastIndex = 0;
    const tf = timeframeOf(c.text);
    if (tf) out.push({ type: "timeframe", text: tf.match, value: tf.tf, span: [c.start + tf.index, c.start + tf.index + tf.match.length] });
    for (const h of findMentions(idx, c.text)) {
      const e = h.entry;
      if (e.kind === "operator") out.push({ type: "operator", text: c.text.slice(h.index, h.end), op: e.op, span: [c.start + h.index, c.start + h.end] });
      else out.push({ type: "kb", kind: e.kind, id: e.id, text: c.text.slice(h.index, h.end), span: [c.start + h.index, c.start + h.end],
                      computable: !("engine" in e) || e.engine.implemented });
    }
  }
  return out.sort((a, b) => a.span[0] - b.span[0]);
}

// What the Reader is told: compact, one line per clause.
export function annotationDigest(clauses: Clause[], ann: Annotation[]): string {
  return clauses.map((c) => {
    const tags = ann.filter((a) => a.span[0] >= c.start && a.span[1] <= c.end).map((a) =>
      a.type === "number" ? `number ${a.value}` : a.type === "timeframe" ? `timeframe ${a.value}` : a.type === "kb" ? `${a.kind} ${a.id}${a.computable ? "" : " (not computable)"}` : `operator ${a.op}`);
    return `${c.id}: ${JSON.stringify(c.text)}${tags.length ? ` [${tags.join("; ")}]` : ""}`;
  }).join("\n");
}
