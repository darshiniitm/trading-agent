import type { ScreenProgram } from "spec";
import { v4ToV5, type V4Spec } from "@/server/compiler/v5/convert";

// A prompt's `spec_json` column holds its confirmed v5 program. Prompts confirmed before v5 hold a v4
// spec; upgrade those on read (a pure, tested conversion) so they keep screening unchanged.
export function programOf(specJson: string): ScreenProgram {
  const parsed = JSON.parse(specJson);
  if (parsed && parsed.program_version === 5) return parsed as ScreenProgram;
  if (parsed && parsed.spec_version === 4) {
    return { ...v4ToV5(parsed as V4Spec), source_phrases: [], needs_input: [], unsupported: [], ignored: [], unrecognised: [], answers: [{ path: "liquidity" }] } as ScreenProgram;
  }
  throw new Error("stored prompt spec is neither a v5 program nor a v4 spec");
}

export function structureOf(program: ScreenProgram): "literal" | "t1_literal" {
  return program.sets.some((s) => s.eval?.mode === "t1_literal") ? "t1_literal" : "literal";
}

export function hasRiskCap(program: ScreenProgram): boolean {
  return program.actions.some((a: any) => a.type === "trade_plan" && a.risk_cap_pct !== null && a.risk_cap_pct !== undefined);
}
