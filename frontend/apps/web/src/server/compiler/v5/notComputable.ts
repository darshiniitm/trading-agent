// "Recognised but not computable" (docs/prompt-agent-interpreter-plan.md §2.3): a prompt that names an
// indicator or field the knowledge repository knows but the engine cannot run yet (Ichimoku, ADX, P/E ...)
// is told so, instead of "not understood". Matching here includes `proposed` entries — it only reports a
// name, it never builds a rule from one.
import { findMentions, indexOf, type Index, type KbEntry } from "spec/src/kb";
import type { Clause } from "./segment";
import type { UnsupportedFrag } from "./recognisers";

let index: Index | null = null;

export function notComputable(c: Clause): UnsupportedFrag[] {
  index ??= indexOf(["reviewed", "proposed"]);
  const hits = findMentions(index, c.text, ["indicator", "field"]).filter((h) => "engine" in h.entry && !h.entry.engine.implemented);
  if (hits.length === 0) return [];
  const names = [...new Set(hits.map((h: { entry: KbEntry }) => h.entry.label))];
  return [{ kind: "unsupported", text: c.text, reason: `recognised: ${names.join(", ")}, not computable yet` }];
}
