// P4 of docs/prompt-agent-interpreter-plan.md: the learning loop and the KB curator.
import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { createDraft, updateDraft } from "@/server/drafts";
import { compileProgramDraft, editChip, editProgramClause } from "@/server/compileProgramDraft";
import { compileProgram } from "@/server/compiler/v5/compileProgram";
import { curateTerm, CurateRejected } from "@/server/compiler/v5/curate";
import { exportGolden, learnFromClauseEdit, pendingProposals, proposeAlias, recordEdit, saveAccepted, shareAsGolden, similarExamples } from "@/server/learning";
import { indexOf, search } from "spec/src/kb";
import { NIFTY_PROCEDURAL } from "./procedural-p0.test";

const setup = (text = NIFTY_PROCEDURAL) => {
  const raw = createTestDb(); const userId = ensureOwnerUser(raw);
  const { draftId } = createDraft(raw, { userId }); updateDraft(raw, draftId, { promptText: text });
  return { raw, userId, draftId };
};

describe("edit capture", () => {
  it("a chip edit is stored as (phrase, compiled value, new value)", async () => {
    const { raw, draftId } = setup();
    await compileProgramDraft(raw, draftId, { useModel: false });
    editChip(raw, draftId, "conditions.C1.params.source", "open");
    const row = raw.prepare("SELECT phrase, compiled_json, edited_json, path FROM interpreter_edit").get() as any;
    expect(row).toMatchObject({ compiled_json: '"close"', edited_json: '"open"', path: "conditions.C1.params.source" });
  });
});

describe("alias proposals", () => {
  it("are queued as proposed, counted, and not used for matching until reviewed", () => {
    const { raw } = setup();
    expect(proposeAlias(raw, { kind: "indicator", id: "rsi", alias: "Relative Strength" })).toMatchObject({ alias: "relative strength", seen: 1, status: "proposed" });
    expect(proposeAlias(raw, { kind: "indicator", id: "rsi", alias: "relative  strength" })!.seen).toBe(2);
    expect(proposeAlias(raw, { kind: "indicator", id: "rsi", alias: "RSI" })).toBeNull();            // already known
    expect(proposeAlias(raw, { kind: "indicator", id: "nope", alias: "x" })).toBeNull();              // not in the KB
    expect(pendingProposals(raw)).toHaveLength(1);
    expect(search(indexOf(["reviewed"]), "relative strength", { kinds: ["indicator"] })[0]?.entry.id).not.toBe(undefined);   // fuzzy via the label, but alias itself not added
  });

  it("a line the tools could not read, rewritten into one that compiles, teaches the old wording", async () => {
    const { raw, userId, draftId } = setup("Nifty 100 stocks\nWeekly\nstrength gauge above 60");
    const v0 = await compileProgramDraft(raw, draftId, { useModel: false });
    const bad = v0.clauses.find((c) => c.status === "not_understood")!;
    expect(bad).toBeTruthy();
    const v1 = await editProgramClause(raw, draftId, bad.id, "RSI(14) above 60", { useModel: false });
    expect(v1.program.conditions).toHaveLength(1);
    expect(pendingProposals(raw)[0]).toMatchObject({ entry_id: "rsi", alias: "strength gauge above" });
    void userId;
  });

  it("a long or numeric old line is not proposed as an alias", async () => {
    const { raw, userId } = setup();
    const p = (await compileProgram("Weekly\nRSI(14) above 60", { resolve: false })).program;
    expect(learnFromClauseEdit(raw, { userId, oldText: "some very long rambling sentence about the strength of things lately", newText: "RSI(14) above 60", program: p })).toBeNull();
  });
});

describe("few-shot store", () => {
  it("returns the most similar accepted prompts, and golden export needs consent", async () => {
    const { raw, userId } = setup();
    const a = (await compileProgram(NIFTY_PROCEDURAL)).program;
    saveAccepted(raw, { userId, promptText: NIFTY_PROCEDURAL, program: a });
    saveAccepted(raw, { userId, promptText: "All stocks between 10K-50K cr\nWeekly\nRSI(14) above 60", program: (await compileProgram("All stocks between 10K-50K cr\nWeekly\nRSI(14) above 60")).program });
    const sim = similarExamples(raw, "Nifty 100 SMA 5 and SMA 20 crossover scanner, daily candles");
    expect(sim[0].prompt).toBe(NIFTY_PROCEDURAL);
    expect(sim[0].conditions[0]).toMatch(/^sma\(length=6/);
    expect(exportGolden(raw)).toEqual([]);
    shareAsGolden(raw, userId, NIFTY_PROCEDURAL);
    expect(exportGolden(raw).map((g) => g.text)).toEqual([NIFTY_PROCEDURAL]);
  });

  it("confirming a draft stores it as an example", async () => {
    const { raw, draftId } = setup();
    await compileProgramDraft(raw, draftId, { useModel: false });
    const { confirmDraft } = await import("@/server/confirm");
    await confirmDraft(raw, draftId, "2026-10-07", (async () => new Response("{}", { status: 500 })) as any).catch(() => {});
    const n = (raw.prepare("SELECT COUNT(*) n FROM interpreter_example").get() as any).n;
    const prompts = (raw.prepare("SELECT COUNT(*) n FROM prompts").get() as any).n;
    expect(n).toBe(prompts);   // an example exists exactly when the prompt was saved
  });

  it("the Reader is shown similar accepted prompts", async () => {
    const { raw, userId, draftId } = setup("Nifty 100 stocks\nTake the 6 day and 30 day simple averages of the close\nTell me when the faster one goes over the slower one");
    saveAccepted(raw, { userId, promptText: NIFTY_PROCEDURAL, program: (await compileProgram(NIFTY_PROCEDURAL)).program });
    const callModel = vi.fn().mockResolvedValue(JSON.stringify({ conditions: [] }));
    await compileProgramDraft(raw, draftId, { callModel });
    expect(callModel.mock.calls.some((c) => /Similar prompts you read before/.test(c[0]))).toBe(true);
  });
});

describe("KB curator", () => {
  const snippet = { url: "https://en.wikipedia.org/wiki/Chaikin_Money_Flow", text: "Chaikin Money Flow measures money flow volume over a period, usually 20 or 21 days." };
  const answer = (over: any = {}) => JSON.stringify({ is_indicator: true, label: "Chaikin Money Flow", aliases: ["cmf"], category: "volume", unit: "oscillator", outputs: ["value"], warmup_bars: "length",
    params: [{ name: "length", label: "length", type: "int", min: 2, max: 200, common_values: [20, 21, 500] }], ...over });

  it("turns an unknown term into a proposed, unimplemented entry with provenance", async () => {
    const e = await curateTerm("chaikin money flow", { callModel: vi.fn().mockResolvedValue(answer()), snippet, now: new Date("2026-10-07") });
    expect(e).toMatchObject({ id: "chaikin_money_flow", engine: { implemented: false }, provenance: { status: "proposed", fetched_at: "2026-10-07", sources: [snippet.url] } });
    expect(e.params[0].common_values).toEqual([20, 21]);   // out-of-range suggestion dropped
    expect(e.aliases).toContain("cmf");
  });

  it("refuses a non-indicator and a collision with an existing entry", async () => {
    await expect(curateTerm("moon phase", { callModel: vi.fn().mockResolvedValue(answer({ is_indicator: false })), snippet })).rejects.toThrow(CurateRejected);
    await expect(curateTerm("rsi", { callModel: vi.fn().mockResolvedValue(answer({ label: "Relative Strength Index" })), snippet })).rejects.toThrow(/collides/);
  });
});
