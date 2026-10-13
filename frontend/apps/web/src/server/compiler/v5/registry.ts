// Indicator registry as the engine publishes it (packages/spec/src/registry.json is generated from
// engine/v5/registry.py:conditions_payload() — one source of truth, no hand-copied drift).
import registryJson from "../../../../../../packages/spec/src/registry.json";

export type RegParam = { name: string; type: string; label: string; min?: number; max?: number; values?: string[] };
export type RegIndicator = {
  name: string; label: string; required_params: RegParam[]; positional_params: string[];
  events: string[]; outputs: string[]; can_supply_stop: boolean; supports_partial_bar: boolean;
};

const reg = registryJson as unknown as { indicators: RegIndicator[]; fields: { name: string; label: string }[] };

export const INDICATORS: Record<string, RegIndicator> = Object.fromEntries(reg.indicators.map((i) => [i.name, i]));
export const FIELDS: Record<string, { name: string; label: string }> = Object.fromEntries(reg.fields.map((f) => [f.name, f]));

export function indLabel(name: string): string { return INDICATORS[name]?.label ?? name.toUpperCase(); }
export function paramMeta(ind: string, param: string): RegParam | undefined {
  return INDICATORS[ind]?.required_params.find((p) => p.name === param);
}
