// Local-model latency controls: per-task thinking, keep-alive/context/output caps, warm-up, and the critic gate.
import { describe, expect, it, vi, afterEach } from "vitest";
import { callOllama, profileFor, TASK_PROFILES, warmModel } from "@/server/compiler/callModel";
import { compileProgram } from "@/server/compiler/v5/compileProgram";
import { interpret } from "@/server/compiler/v5/interpret";
import { ruleCritic } from "@/server/compiler/v5/critic";

const stream = (content: string) => ({ ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify({ message: { content }, done: true }) + "\n")); c.close(); } }) });
const sent = (f: ReturnType<typeof vi.fn>, n = 0) => JSON.parse(f.mock.calls[n][1].body);

describe("per-task model profiles", () => {
  afterEach(() => vi.restoreAllMocks());

  it("copy-into-a-closed-schema work runs without thinking; reasoning work keeps it", () => {
    for (const t of ["fallback", "reader"] as const) expect(TASK_PROFILES[t].think).toBe(false);   // output re-verified against the prompt
    for (const t of ["modelRead", "critic", "curate"] as const) expect(TASK_PROFILES[t].think).toBe(true);
  });

  it("OLLAMA_THINK_<TASK> overrides one task only", () => {
    expect(profileFor("fallback", { OLLAMA_THINK_FALLBACK: "1" } as any)?.think).toBe(true);
    expect(profileFor("critic", { OLLAMA_THINK_CRITIC: "0" } as any)?.think).toBe(false);
    expect(profileFor("critic", {} as any)?.think).toBe(true);
    expect(profileFor(undefined)).toBeUndefined();
  });

  it("sends think, a keep-alive, a fixed context and an output cap for a task", async () => {
    const f = vi.fn().mockImplementation(async () => stream("{}"));
    await callOllama("s", "u", undefined, f as any, "m1", { task: "fallback" });
    const b = sent(f);
    expect(b.think).toBe(false);
    expect(b.keep_alive).toBeTruthy();
    expect(b.options).toMatchObject({ temperature: 0, num_ctx: expect.any(Number), num_predict: TASK_PROFILES.fallback.num_predict });
    await callOllama("s", "u", undefined, f as any, "m1", { task: "critic" });
    expect(sent(f, 1).think).toBe(true);
  });

  it("a call with no task keeps the old behaviour (no think, no output cap)", async () => {
    const f = vi.fn().mockImplementation(async () => stream("{}"));
    await callOllama("s", "u", undefined, f as any, "m2");
    const b = sent(f);
    expect("think" in b).toBe(false);
    expect("num_predict" in b.options).toBe(false);
  });

  it("a model without a thinking mode is asked again without `think`, and remembered", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: '"mistral:latest" does not support thinking' }) })
      .mockImplementation(async () => stream("{}"));
    await callOllama("s", "u", undefined, f as any, "no-think-model", { task: "reader" });
    expect(f).toHaveBeenCalledTimes(2);
    expect("think" in sent(f, 1)).toBe(false);
    await callOllama("s", "u", undefined, f as any, "no-think-model", { task: "reader" });
    expect("think" in sent(f, 2)).toBe(false);
  });

  it("warmModel loads the model with an empty chat and never throws", async () => {
    const f = vi.fn().mockResolvedValue({ ok: true });
    expect(await warmModel("m3", f as any)).toBe(true);
    expect(sent(f)).toMatchObject({ model: "m3", messages: [], keep_alive: expect.any(String) });
    expect(await warmModel("m3", vi.fn().mockRejectedValue(new Error("down")) as any)).toBe(false);
  });
});

describe("the model critic is a second opinion on a model's reading", () => {
  const TC06 = "MACD (12,26,9) bullish crossover below the zero line in the last 2 sessions, Nifty 200";

  it("a crossover with a companion condition is not reported as a reversed comparator", async () => {
    const d = await compileProgram(TC06, { resolve: false });
    expect(d.program.conditions.length).toBeGreaterThan(1);   // the cross + its companions share the phrase
    expect(ruleCritic(d.normalised, d.clauses, d.program).filter((i) => i.kind === "reversed")).toEqual([]);
  });

  it("a real reversal is still caught", async () => {
    const d = await compileProgram("Nifty 200 stocks with RSI(14) below 30", { resolve: false });
    const p = JSON.parse(JSON.stringify(d.program));
    p.conditions[0].op = ">";
    expect(ruleCritic(d.normalised, d.clauses, p).some((i) => i.kind === "reversed")).toBe(true);
  });

  it("is not called for a prompt the rules read alone, even when a rule check has something to say", async () => {
    const critic = vi.fn().mockResolvedValue([]);
    const text = "Nifty 200 stocks with RSI(14) above 60 and weekly volume 777";
    const r = await interpret(text, { critic });
    expect(r.draft.modelCalls).toBe(0);
    expect(critic).not.toHaveBeenCalled();
  });
});
