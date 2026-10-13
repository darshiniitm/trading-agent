// registry.json is GENERATED from the knowledge repository: the implemented indicator and field
// entries, in file order. The compiler (compiler/v5/registry.ts), the engine's /conditions payload and
// the UI all read that one file, so there is no hand-copied list to drift.
import type { FieldKb, IndicatorKb, KbEntry, KbParam } from "./schema";

export const OPS = [">", ">=", "<", "<=", "==", "between", "outside", "flip", "cross_above", "cross_below", "cross_any", "rising", "falling", "up_over", "down_over"];
export const TIMEFRAMES = ["1D", "1W", "1M"];

const regParam = (p: KbParam) => ({
  name: p.name, type: p.type, label: p.label,
  ...(p.min !== undefined ? { min: p.min } : {}), ...(p.max !== undefined ? { max: p.max } : {}),
  ...(p.values ? { values: p.values } : {}),
});

export function generateRegistry(entries: KbEntry[]) {
  const live = entries.filter((e) => e.provenance.status !== "retired" && "engine" in e && e.engine.implemented);
  const indicators = live.filter((e): e is IndicatorKb => e.kind === "indicator").map((e) => ({
    kind: "indicator" as const, name: e.id, label: e.label,
    required_params: e.params.map(regParam),
    positional_params: e.params.filter((p) => p.positional !== undefined).sort((a, b) => a.positional! - b.positional!).map((p) => p.name),
    events: e.events, outputs: e.outputs, supports_partial_bar: e.supports_partial_bar, can_supply_stop: e.can_supply_stop,
  }));
  const fields = live.filter((e): e is FieldKb => e.kind === "field").map((e) => ({
    kind: "field" as const, name: e.id, label: e.label, required_params: e.params.map(regParam),
  }));
  return { fields, indicators, ops: OPS, timeframes: TIMEFRAMES };
}
