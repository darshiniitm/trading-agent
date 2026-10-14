// Step 7 — dry run (plan §3). Runs the resolved program on the latest as-of through the engine and reports
// counts and data gaps. Never blocks and never throws: a failure becomes a warning. The adapter reads the
// engine's /screen/v5 answer defensively ({sets:[{id,count|n|size}], universe_count, data_gaps}).
import type { ScreenProgram } from "spec";
import { screenProgram } from "@/server/engine/client";

export type DryRun = { as_of: string; ok: boolean; counts: { id: string; label: string; count: number }[]; universe: number | null; warnings: string[] };

const num = (...xs: unknown[]) => xs.find((x): x is number => typeof x === "number") ?? null;

export function summariseDryRun(result: any, program: ScreenProgram, asOf: string): DryRun {
  const warnings: string[] = [];
  const rawSets: any[] = Array.isArray(result?.sets) ? result.sets : result?.sets && typeof result.sets === "object" ? Object.entries(result.sets).map(([id, v]: [string, any]) => ({ id, ...(typeof v === "object" ? v : { count: v }) })) : [];
  const counts = rawSets.map((s) => ({ id: String(s.id), label: program.sets.find((x) => x.id === s.id)?.label ?? String(s.id), count: num(s.count, s.n, s.size, Array.isArray(s.symbols) ? s.symbols.length : null) ?? -1 }))
    .filter((c) => c.count >= 0);
  const universe = num(result?.universe_count, result?.universe_size);
  if (counts.length === 0) warnings.push("the engine answered but its counts could not be read");
  const last = counts.at(-1);
  if (last && last.count === 0) warnings.push(`${last.id} matched no stocks as of ${asOf} — check the thresholds`);
  if (last && universe && last.count === universe) warnings.push(`${last.id} matched every stock in the universe — the conditions may not be filtering`);
  for (const g of Array.isArray(result?.data_gaps) ? result.data_gaps : []) warnings.push(`data gap: ${typeof g === "string" ? g : JSON.stringify(g)}`);
  return { as_of: asOf, ok: counts.length > 0, counts, universe, warnings };
}

export async function dryRun(program: ScreenProgram, asOf: string, screen: typeof screenProgram = screenProgram, fetchFn?: typeof fetch): Promise<DryRun> {
  try { return summariseDryRun(await screen(program, asOf, fetchFn), program, asOf); }
  catch (e) { return { as_of: asOf, ok: false, counts: [], universe: null, warnings: [`dry run unavailable: ${(e as Error).message}`] }; }
}
