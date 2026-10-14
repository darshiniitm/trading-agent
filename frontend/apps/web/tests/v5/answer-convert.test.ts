import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileProgram as resolvingCompile } from "@/server/compiler/v5/compileProgram";
// these tests are about the compiler stage itself, before the interpreter fills open slots (see interpreter.test.ts)
const compileProgram = (t: string, o: any = {}) => resolvingCompile(t, { ...o, resolve: false });
import { applyLiquidity } from "@/server/compiler/v5/liquidity";
import { applyProgramAnswer, AnswerError, ignoreClause, programConfirmProblems } from "@/server/compiler/v5/answer";
import { v4ToV5 } from "@/server/compiler/v5/convert";
import { verifyProgram, pathProblem } from "@/server/compiler/v5/verify";
import { SAMPLE } from "./samples";

const FIX = JSON.parse(readFileSync(path.join(__dirname, "fixtures/v4-to-v5.json"), "utf8")) as { name: string; spec: any; program: any }[];

describe("v4 -> v5 converter", () => {
  it.each(FIX.map((f) => [f.name, f] as const))("matches the engine's Python converter: %s", (_n, f) => {
    expect(v4ToV5(f.spec)).toEqual(f.program);
  });
});

describe("answering questions", () => {
  async function answerAll() {
    const d = await compileProgram(SAMPLE);
    let p = d.program;
    const answers: [string, unknown][] = [
      ["conditions.C2.params.source", "close"], ["conditions.C3.params.length", 14],
      ["actions.A1.highlight.metric", "sector_return_vs_benchmark"],
      ["actions.A2.entry.at", "signal_close"], ["actions.A2.confidence.method", "conditions_met_count"],
      ["actions.A2.set", "S2"],
    ];
    for (const [path, v] of answers) p = applyProgramAnswer(p, path, v);
    return { d, p };
  }

  it("a chosen outperformance metric opens its own follow-up questions", async () => {
    const { p } = await answerAll();
    expect(p.needs_input.map((n) => n.path)).toEqual([
      "actions.A3.horizons_w", "actions.A1.highlight.lookback_weeks", "actions.A1.highlight.rule.rs_gt", "actions.A1.highlight.rule.top_k",
    ]);
    let q = applyProgramAnswer(p, "actions.A1.highlight.lookback_weeks", 4);
    q = applyProgramAnswer(q, "actions.A1.highlight.rule.rs_gt", "0");
    q = applyProgramAnswer(q, "actions.A1.highlight.rule.top_k", 3);
    q = applyProgramAnswer(q, "actions.A3.horizons_w", [1, 2, 3]);
    expect(q.needs_input).toEqual([]);
    expect(q.actions[0]).toMatchObject({ highlight: { metric: "sector_return_vs_benchmark", lookback_weeks: 4, rule: { rs_gt: 0, top_k: 3 } } });
    expect(programConfirmProblems(q)).toEqual([]);   // liquidity is an optional add-on now, never a question
  });

  it("answers land on the id-keyed path, are traced as user answers, and the program still verifies", async () => {
    const { d, p } = await answerAll();
    expect((p.conditions[1].lhs as any).params).toMatchObject({ length: 10, mult: 2, source: "close" });
    expect((p.conditions[2].lhs as any).params.length).toBe(14);
    expect(p.actions[1]).toMatchObject({ set: "S2", entry: { at: "signal_close" } });
    expect(() => verifyProgram(p, d.normalised)).not.toThrow();
    expect(p.answers.map((a) => a.path)).toContain("conditions.C3.params.length");
  });

  it("validates answers against the registry — no out-of-range or wrong-type values", async () => {
    const d = await compileProgram(SAMPLE);
    expect(() => applyProgramAnswer(d.program, "conditions.C3.params.length", 1)).toThrow(/between 2 and 100/);
    expect(() => applyProgramAnswer(d.program, "conditions.C3.params.length", "abc")).toThrow(AnswerError);
    expect(() => applyProgramAnswer(d.program, "conditions.C2.params.source", "midpoint")).toThrow(/one of/);
    expect(() => applyProgramAnswer(d.program, "actions.A2.entry.at", "whenever")).toThrow(/offered options/);
    expect(() => applyProgramAnswer(d.program, "actions.A2.set", "S1")).toThrow(/offered options/);
    expect(() => applyProgramAnswer(d.program, "conditions.C1.value", 1)).toThrow(/no open question/);
  });

  it("refuses prototype-pollution paths and anything outside the grammar", async () => {
    const d = await compileProgram(SAMPLE);
    for (const bad of ["conditions.C2.params.__proto__", "conditions.C2.params.constructor", "a.b", "conditions.0.params.length", "actions.A2.__proto__.x"]) {
      expect(pathProblem(bad)).not.toBeNull();
      expect(() => applyProgramAnswer(d.program, bad, 1)).toThrow(AnswerError);
    }
  });

  it("contradiction: choosing an option writes the user's own numbers and clears the question", async () => {
    const d = await compileProgram("All stocks below 10K-50K cr Market Cap");
    const opt = d.program.needs_input[0].options![2].value;
    const p = applyProgramAnswer(d.program, "conditions.C1.op", opt);
    expect(p.conditions[0]).toMatchObject({ op: "outside", value: [10000, 50000] });
    expect(p.needs_input).toEqual([]);
    expect(() => verifyProgram(p, d.normalised)).not.toThrow();
  });

  it("placeholders: answering both bounds fills the band; verify accepts the answered values", async () => {
    const d = await compileProgram("Weekly\nRSI(14) Range X to Y");
    let p = applyProgramAnswer(d.program, "conditions.C1.value.0", 50);
    p = applyProgramAnswer(p, "conditions.C1.value.1", 65);
    expect(p.conditions[0].value).toEqual([50, 65]);
    expect(() => verifyProgram(p, d.normalised)).not.toThrow();
  });

  it("a not-understood clause no longer blocks anything: the interpreter greys it out and the rest runs", async () => {
    const d = await compileProgram("All stocks between 10K-50K cr\nthe moon is in the seventh house");
    expect(programConfirmProblems(d.program)).toEqual([]);
    const p = ignoreClause(d.program, "L2");
    expect(p.ignored.at(-1)).toMatchObject({ reason: "ignored by you" });
  });
});

describe("traceability (verify)", () => {
  it("rejects a value whose source phrase does not contain it", async () => {
    const d = await compileProgram(SAMPLE);
    const forged = JSON.parse(JSON.stringify(d.program));
    forged.conditions[1].lhs.params.length = 14;   // the prompt says 10
    expect(() => verifyProgram(forged, d.normalised)).toThrow(/cannot be read from its source phrase/);
  });
  it("rejects a source phrase whose span is not in the prompt, and a value with no phrase or answer", async () => {
    const d = await compileProgram(SAMPLE);
    const a = JSON.parse(JSON.stringify(d.program)); a.source_phrases[0].span = [0, 3];
    expect(() => verifyProgram(a, d.normalised)).toThrow(/span does not contain/);
    const b = JSON.parse(JSON.stringify(d.program)); b.conditions[2].lhs.params.length = 14;
    expect(() => verifyProgram(b, d.normalised)).toThrow(/no source phrase and no user answer/);
  });
});


describe("liquidity (the app's own question, never defaulted)", () => {
  it("a floor becomes a condition on the set that starts from the universe, traced to the user's answer", async () => {
    const d = await compileProgram("All stocks between 10K-50K cr");
    const p = applyLiquidity(d.program, { mode: "floor", cr: 10 });
    expect(p.conditions[1]).toMatchObject({ id: "C2", lhs: { field: "traded_value_cr", params: { window: "8W" } }, op: ">=", value: 10 });
    expect(p.sets[0].where).toEqual({ all: ["C1", "C2"] });
    expect(p.answers.map((a) => a.path)).toEqual(expect.arrayContaining(["liquidity", "conditions.C2.value", "conditions.C2.params.window"]));
    expect(() => verifyProgram(p, d.normalised)).not.toThrow();
    expect(programConfirmProblems(p)).toEqual([]);
  });

  it("'no filter' adds nothing but is recorded as answered; re-answering replaces the earlier answer cleanly", async () => {
    const d = await compileProgram("All stocks between 10K-50K cr");
    const none = applyLiquidity(d.program, { mode: "none" });
    expect(none.conditions).toHaveLength(1);
    expect(none.answers.map((a) => a.path)).toEqual(["liquidity"]);
    const floor = applyLiquidity(none, { mode: "floor", cr: 10 });
    const custom = applyLiquidity(floor, { mode: "floor", cr: 25 });
    expect(custom.conditions.map((c) => c.id)).toEqual(["C1", "C2"]);
    expect(custom.conditions[1].value).toBe(25);
    expect(custom.sets[0].where).toEqual({ all: ["C1", "C2"] });
    expect(custom.answers.filter((a) => a.path === "liquidity")).toHaveLength(1);
    const back = applyLiquidity(custom, { mode: "none" });
    expect(back.conditions).toHaveLength(1);
    expect(back.sets[0].where).toEqual({ all: ["C1"] });
  });

  it("refuses a non-positive or non-numeric floor", async () => {
    const d = await compileProgram("All stocks between 10K-50K cr");
    for (const cr of [0, -5, Number.NaN]) expect(() => applyLiquidity(d.program, { mode: "floor", cr })).toThrow(AnswerError);
  });
});

describe("stored prompts", () => {
  it("a v4 spec is upgraded on read; a v5 program is returned as is; anything else is refused", async () => {
    const { programOf } = await import("@/server/programOf");
    const v5 = programOf(JSON.stringify(FIX[0].spec));
    expect(v5.program_version).toBe(5);
    expect(v5.answers).toEqual([{ path: "liquidity" }]);
    expect(programOf(JSON.stringify(v5))).toEqual(v5);
    expect(() => programOf("{}")).toThrow(/neither/);
  });
});
