import { describe, expect, it } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { createDraft, getDraft, saveProgramState, updateDraft } from "@/server/drafts";
import { program } from "./helpers/program";

async function setup() {
  const raw = await createTestDb();
  const userId = await ensureOwnerUser(raw);
  return { raw, userId };
}

describe("createDraft", () => {
  it("creates an open draft with an empty prompt_text and no program", async () => {
    const { raw, userId } = await setup();
    const { draftId } = await createDraft(raw, { userId });
    const row = (await getDraft(raw, draftId))!;
    expect(row.status).toBe("open");
    expect(row.promptText).toBe("");
    expect(row.program).toBeNull();
    expect(row.programClauses).toBeNull();
  });
});

describe("updateDraft", () => {
  it("stores title, prompt text, hypothesis and kill criterion", async () => {
    const { raw, userId } = await setup();
    const { draftId } = await createDraft(raw, { userId });
    const updated = await updateDraft(raw, draftId, { title: "t", promptText: "p", hypothesis: "h", killCriterion: "k" });
    expect(updated).toMatchObject({ title: "t", promptText: "p", hypothesis: "h", killCriterion: "k" });
  });

  it("rejects a prompt text over 2000 characters with a plain message", async () => {
    const { raw, userId } = await setup();
    const { draftId } = await createDraft(raw, { userId });
    expect(async () => await updateDraft(raw, draftId, { promptText: "x".repeat(2001) })).toThrow(/2000 characters/);
  });

  it("refuses to write the server-owned program columns through the generic update", async () => {
    const { raw, userId } = await setup();
    const { draftId } = await createDraft(raw, { userId });
    expect(async () => await updateDraft(raw, draftId, { programJson: "{}" } as any)).toThrow(/cannot update: programJson/);
    expect(async () => await updateDraft(raw, 9999, { title: "x" })).toThrow(/not found/);
  });
});

describe("saveProgramState", () => {
  it("round-trips the program, the clause view and the normalised text; later saves keep what they don't replace", async () => {
    const { raw, userId } = await setup();
    const { draftId } = await createDraft(raw, { userId });
    const clauses = [{ id: "L1", text: "x", span: [0, 1] as [number, number], status: "ok" as const, maps_to: "C1", questions: 0 }];
    await saveProgramState(raw, draftId, { program: program(), clauses, normalised: "x" });
    const again = await saveProgramState(raw, draftId, { program: program({ answers: [] }), clauses: null });
    expect(again.program!.answers).toEqual([]);
    expect(again.programClauses).toEqual(clauses);
    expect(again.programNormalised).toBe("x");
  });
});
