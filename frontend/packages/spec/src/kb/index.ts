// Server-side entry point for the knowledge repository. Import from "spec/src/kb" (not from "spec")
// so the catalogue stays out of client bundles.
import { z } from "zod";
import bundle from "../kb.generated.json";
import { KbEntrySchema, type IndicatorKb, type KbEntry, type KbStatus } from "./schema";
import { buildIndex, type Index } from "./search";

export * from "./schema";
export * from "./search";
export * from "./generate";

let cached: KbEntry[] | null = null;
export function kbEntries(): KbEntry[] {
  return (cached ??= z.array(KbEntrySchema).parse((bundle as { entries: unknown[] }).entries));
}
export const kbEntry = (id: string, kind?: KbEntry["kind"]) => kbEntries().find((e) => e.id === id && (!kind || e.kind === kind));
export const reviewedIndex = (): Index => buildIndex(kbEntries(), ["reviewed"]);
export const indexOf = (statuses: readonly KbStatus[]): Index => buildIndex(kbEntries(), statuses);

// Bars of history an indicator needs, from its warmup rule ("slow + signal") and the params stated or assumed.
export function warmupBars(e: IndicatorKb, params: Record<string, number | string | null | undefined>): number | null {
  let total = 0;
  for (const raw of e.warmup_bars.split("+")) {
    const term = raw.trim();
    const mul = /^(\w+)\s*\*\s*(\d+)$/.exec(term);
    const name = mul ? mul[1] : term;
    const k = mul ? Number(mul[2]) : 1;
    const v = /^\d+$/.test(name) ? Number(name) : params[name];
    if (typeof v !== "number") return null;
    total += v * k;
  }
  return total;
}
