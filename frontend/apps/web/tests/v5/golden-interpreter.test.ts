// P5 / §8.1 of docs/prompt-agent-interpreter-plan.md: golden set, slot accuracy, coverage, determinism, no invented values.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compileProgram } from "@/server/compiler/v5/compileProgram";
import { interpret } from "@/server/compiler/v5/interpret";
import { GOLDEN_INTERPRETER, SLOT_NAMES, slotMatches, slotReport } from "@/server/compiler/v5/goldenInterpreter";
import { verifyProgram } from "@/server/compiler/v5/verify";

const toolsOnly = GOLDEN_INTERPRETER.filter((c) => !c.needsModel);

describe("interpreter golden set — tools only (no model)", () => {
  it("has ≥ 40 paraphrases plus Reader-only cases", () => {
    expect(toolsOnly.length).toBeGreaterThanOrEqual(40);
    expect(GOLDEN_INTERPRETER.filter((c) => c.needsModel).length).toBeGreaterThanOrEqual(5);
    expect(new Set(GOLDEN_INTERPRETER.map((c) => c.text)).size).toBe(GOLDEN_INTERPRETER.length);
  });

  it.each(toolsOnly.map((c) => [c.id, c] as const))("%s: every slot matches, every line accounted for, values trace", async (_id, c) => {
    const d = await compileProgram(c.text, { resolve: false });
    const m = slotMatches(d.program, c.expected);
    expect(Object.entries(m).filter(([, ok]) => !ok).map(([s]) => s), c.text).toEqual([]);
    expect(d.program.unrecognised).toEqual([]);
    expect(d.program.conditions).toHaveLength(1);
    expect(d.modelCalls).toBe(0);
    expect(() => verifyProgram(d.program, d.normalised)).not.toThrow();   // no invented values
    const r = await interpret(c.text);
    expect(r.coverage.unaccounted).toEqual([]);
    expect(r.coverage.flagged).toEqual([]);
    expect(r.issues, c.text).toEqual([]);
  });

  it("slot accuracy is reported per slot and is 100% for the tools-only set", async () => {
    const rows = [];
    for (const c of toolsOnly) rows.push(slotMatches((await compileProgram(c.text, { resolve: false })).program, c.expected));
    const rep = slotReport(rows);
    for (const s of SLOT_NAMES) expect(rep[s], s).toBe(1);
  });

  it("determinism: same prompt → same program hash, 10 runs (sampled across the set)", async () => {
    for (const c of toolsOnly.filter((_, i) => i % 8 === 0)) {
      const hs = new Set<string>();
      for (let i = 0; i < 10; i++) hs.add(createHash("sha256").update(JSON.stringify((await compileProgram(c.text)).program)).digest("hex"));
      expect(hs.size, c.id).toBe(1);
    }
  });

  it("Reader-only cases are NOT readable by the tools alone (so they really measure the Reader)", async () => {
    for (const c of GOLDEN_INTERPRETER.filter((x) => x.needsModel)) {
      const d = await compileProgram(c.text, { resolve: false });
      expect(slotMatches(d.program, c.expected).operator, c.id).toBe(false);
    }
  });
});
