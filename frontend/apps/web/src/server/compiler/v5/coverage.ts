// Coverage (plan §3 step 5): every line of the prompt is used, ignored with a reason, or flagged — never
// silently dropped.
import type { ClauseView } from "spec";

export type Coverage = { used: string[]; ignored: { id: string; reason: string }[]; flagged: { id: string; text: string; why: string }[]; unaccounted: string[] };

export function coverage(clauses: ClauseView[]): Coverage {
  const c: Coverage = { used: [], ignored: [], flagged: [], unaccounted: [] };
  for (const cl of clauses) {
    if (cl.status === "not_understood") c.flagged.push({ id: cl.id, text: cl.text, why: cl.maps_to || "not understood" });
    else if (cl.status === "ignored") c.ignored.push({ id: cl.id, reason: cl.maps_to });
    else if (/not computable yet/.test(cl.maps_to) && !/[A-C]\d+:/.test(cl.maps_to)) c.flagged.push({ id: cl.id, text: cl.text, why: cl.maps_to });
    else if (cl.maps_to.trim()) c.used.push(cl.id);
    else c.unaccounted.push(cl.id);
  }
  return c;
}
