// The 20 trader prompts from "Prompt Screener — Golden Test Cases": each must compile (rules only, no model) to the
// reviewed set of conditions, with nothing left open, nothing unread, and every implied value shown as an assumption.
// The stock lists are checked end to end by the engine repo (tests/golden/run_golden.py).
import { describe, expect, it } from "vitest";
import prompts from "./fixtures/golden-trader-prompts.json";
import expected from "./fixtures/golden-trader-conditions.json";
import { compileProgram } from "@/server/compiler/v5/compileProgram";
import { interpret } from "@/server/compiler/v5/interpret";
import { verifyProgram } from "@/server/compiler/v5/verify";
import { canonicalTrader } from "./helpers/canonTrader";

const ids = Object.keys(prompts).sort();

describe("golden trader prompts compile to the reviewed conditions", () => {
  it.each(ids)("%s", async (id) => {
    const text = (prompts as Record<string, string>)[id];
    const d = await compileProgram(text);
    expect(canonicalTrader(d.program)).toEqual((expected as Record<string, string[]>)[id]);
    expect(d.program.unrecognised).toEqual([]);
    expect(d.program.needs_input).toEqual([]);
    expect(() => verifyProgram(d.program, d.normalised)).not.toThrow();
    expect(d.modelCalls).toBe(0);
  });

  it("every implied value is listed as an assumption with a reason (nothing is filled silently)", async () => {
    for (const id of ids) {
      const d = await compileProgram((prompts as Record<string, string>)[id]);
      for (const a of d.program.assumptions ?? []) {
        expect(a.label.length, `${id} ${a.path}`).toBeGreaterThan(2);
        expect(a.value, `${id} ${a.path}`).not.toBeNull();
        expect(a.value, `${id} ${a.path}`).not.toBeUndefined();
      }
    }
  });

  it("the plain-English reading says what will run (crosses, levels, multiples, windows)", async () => {
    const r = await interpret((prompts as Record<string, string>)["TC06"]);
    expect(r.english).toMatch(/signal line/);
    const k = await interpret((prompts as Record<string, string>)["TC01"]);
    expect(k.english).toMatch(/× 1\.3/);
    expect(k.english).toMatch(/higher than it was 21 bars ago/);
    const t = await interpret((prompts as Record<string, string>)["TC17"]);
    expect(t.english).toMatch(/2 × ATR\(14\)/);
    expect(t.english).toMatch(/target of 2R/);
  });

  it("the critic raises nothing for a prompt every phrase of which was read", async () => {
    for (const id of ["TC02", "TC04", "TC05", "TC08", "TC09", "TC18", "TC19"]) {
      const r = await interpret((prompts as Record<string, string>)[id]);
      expect(r.issues, id).toEqual([]);
    }
  });

  it("P/E and ROE are reported as not computable, so no stock can be a full match", async () => {
    const d = await compileProgram((prompts as Record<string, string>)["TC20"]);
    expect(d.program.not_evaluable?.some((n) => n.id === "unsupported" && /not computable yet/.test(n.reason))).toBe(true);
  });

  it("a universe number is not an average length: 'Nifty 100 SMA crossover'", async () => {
    const d = await compileProgram("Nifty 100 stocks where the 50 DMA crossed above the 200 DMA in the last 10 sessions");
    expect(d.program.universe).toMatchObject({ source: "index", index: "NIFTY 100" });
    expect(d.program.conditions.map((c: any) => c.lhs.params.length)).toEqual([50, 50]);
  });

  it("a universe plus words nothing could read is flagged and sent to the model, never reported as understood", async () => {
    const seen: string[] = [];
    const d = await compileProgram("Nifty 100 stocks where the mood is bullish above 5", { modelRead: async (i) => { seen.push(i.leftover); return []; } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/above 5/);
    expect(d.program.universe).toMatchObject({ index: "NIFTY 100" });
    expect(d.program.not_evaluable?.some((n) => /could not be turned into a rule/.test(n.reason))).toBe(true);
  });

  it("a title or an introduction ending in a colon is not a rule and is not flagged", async () => {
    const d = await compileProgram("Build a Nifty 100 SMA crossover scanner:\nSMA 6 and SMA 30 crossover in the last 5 bars");
    expect(d.program.not_evaluable?.some((n) => /could not be turned into a rule/.test(n.reason)) ?? false).toBe(false);
  });
});
