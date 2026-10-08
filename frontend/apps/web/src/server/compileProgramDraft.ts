import type Database from "better-sqlite3";
import type { ClauseView, ScreenProgram } from "spec";
import { programConfirmProblems } from "@/server/compiler/v5/answer";
import { applyLiquidity, applyMinPrice, addonState, type LiquidityChoice } from "@/server/compiler/v5/liquidity";
import { interpret } from "@/server/compiler/v5/interpret";
import { makeReader, type Example } from "@/server/compiler/v5/reader";
import { makeModelCritic, ruleCritic, type Issue } from "@/server/compiler/v5/critic";
import { renderEnglish } from "@/server/compiler/v5/render";
import { toFiveSlots } from "@/server/compiler/v5/slots5";
import { coverage } from "@/server/compiler/v5/coverage";
import { learnFromClauseEdit, recordEdit, similarExamples } from "@/server/learning";
import { makeClauseFallback, type CallModelFn } from "@/server/compiler/v5/fallback";
import { applyChipEdit, resolveProgram } from "@/server/compiler/v5/resolve";
import { resolvedJson, toSlotConditions, type SlotCondition } from "@/server/compiler/v5/slots";
import { getUserDefaults, type UserDefaults } from "@/server/userDefaults";
import { feasibility, screenProgram, uploadUniverse } from "@/server/engine/client";
import { getDraft, saveProgramState, updateDraft, type DraftRow } from "@/server/drafts";

export type ProgramView = {
  program: ScreenProgram; clauses: ClauseView[]; normalised: string;
  conditions: SlotCondition[];                 // the 4-slot rules, with provenance per slot
  chips: NonNullable<ScreenProgram["assumptions"]>;   // every assumed / inferred value, editable in place
  notEvaluable: NonNullable<ScreenProgram["not_evaluable"]>;
  addons: ReturnType<typeof addonState>;
  problems: string[]; ready: boolean;
  // the interpreter's own account (plan §1, §3.2): plain-English reading, five slots with provenance, critic issues, coverage
  english: string; fiveSlots: ReturnType<typeof toFiveSlots>; issues: Issue[]; coverage: ReturnType<typeof coverage>;
  reader?: { calls: number; dropped: string[] };
};

export function viewOf(draft: DraftRow, defaults: UserDefaults): ProgramView {
  const program = resolveProgram(draft.program!, defaults);   // idempotent; also upgrades a draft compiled before the interpreter
  const problems = programConfirmProblems(program);
  return {
    program, clauses: draft.programClauses ?? [], normalised: draft.programNormalised ?? "",
    conditions: toSlotConditions(program, defaults), chips: program.assumptions ?? [], notEvaluable: program.not_evaluable ?? [],
    addons: addonState(program), problems, ready: problems.length === 0,
    english: renderEnglish(program), fiveSlots: toFiveSlots(program), coverage: coverage(draft.programClauses ?? []),
    issues: ruleCritic(draft.programNormalised ?? "", draft.programClauses ?? [], program),
  };
}

const defaultsOf = (raw: Database.Database, userId: number) => getUserDefaults(raw, userId);

// Compile the draft's prompt text to a v5 program. Recognisers do the parsing; the model (if given)
// only sees lines no recogniser claimed, one schema-constrained call per line. Every slot the prompt left
// open is then filled from the user's saved defaults and listed as a chip — nothing is asked.
export async function compileProgramDraft(raw: Database.Database, draftId: number, { callModel, useModel = true }: { callModel?: CallModelFn; useModel?: boolean } = {}): Promise<ProgramView> {
  const draft = getDraft(raw, draftId);
  if (!draft) throw new Error(`draft ${draftId} not found`);
  if (!draft.promptText.trim()) throw new Error("draft has no prompt text yet");
  const defaults = defaultsOf(raw, draft.userId);
  const examples: Example[] = useModel ? similarExamples(raw, draft.promptText, 4) : [];
  const r = await interpret(draft.promptText, {
    defaults, fallback: useModel ? makeClauseFallback(callModel) : undefined,
    reader: useModel ? makeReader(callModel) : undefined, critic: useModel ? makeModelCritic(callModel) : undefined, examples,
  });
  const view = viewOf(saveProgramState(raw, draftId, { program: r.program, clauses: r.draft.clauses, normalised: r.draft.normalised }), defaults);
  // the model critic's issues are not stored with the draft; they ride along on this response
  return { ...view, issues: r.issues, reader: r.reader };
}

function load(raw: Database.Database, draftId: number) {
  const draft = getDraft(raw, draftId);
  if (!draft?.program) throw new Error(`draft ${draftId} has no compiled program yet`);
  return { draft, defaults: defaultsOf(raw, draft.userId) };
}

// Editing a chip replaces one assumed value; the rest of the program is untouched and the screen can re-run.
export function editChip(raw: Database.Database, draftId: number, path: string, value: unknown): ProgramView {
  const { draft, defaults } = load(raw, draftId);
  const before = (resolveProgram(draft.program!, defaults).assumptions ?? []).find((a) => a.path === path);
  const program = applyChipEdit(resolveProgram(draft.program!, defaults), path, value, defaults);
  recordEdit(raw, { userId: draft.userId, draftId, phrase: before?.label ?? path, from: before?.value, to: value, path });
  return viewOf(saveProgramState(raw, draftId, { program, clauses: draft.programClauses }), defaults);
}

export type AddonChoice = { liquidity: LiquidityChoice } | { min_price: { mode: "none" } | { mode: "floor"; price: number } };
// Optional add-ons are off until switched on; switching one on adds an ordinary condition to the base set.
export function setAddon(raw: Database.Database, draftId: number, choice: AddonChoice): ProgramView {
  const { draft, defaults } = load(raw, draftId);
  const base = resolveProgram(draft.program!, defaults);
  const program = "liquidity" in choice ? applyLiquidity(base, choice.liquidity) : applyMinPrice(base, choice.min_price);
  return viewOf(saveProgramState(raw, draftId, { program, clauses: draft.programClauses }), defaults);
}

// Editing a line rewrites that line in the (normalised) prompt text and recompiles. Earlier chip edits are
// dropped — they were edits to the old wording.
export async function editProgramClause(raw: Database.Database, draftId: number, clauseId: string, text: string, opts: { callModel?: CallModelFn; useModel?: boolean } = {}): Promise<ProgramView> {
  const draft = getDraft(raw, draftId);
  const clause = draft?.programClauses?.find((c) => c.id === clauseId);
  if (!draft || !clause || draft.programNormalised == null) throw new Error("clause not found");
  const norm = draft.programNormalised;
  const edited = norm.slice(0, clause.span[0]) + text.replace(/\n/g, " ").trim() + norm.slice(clause.span[1]);
  updateDraft(raw, draftId, { promptText: edited });
  const view = await compileProgramDraft(raw, draftId, opts);
  // the old wording, rewritten by the user into something that now compiles, may become an alias proposal
  const now = view.clauses.find((c) => c.id === clauseId);
  if (clause.status === "not_understood" && now && now.status !== "not_understood") {
    learnFromClauseEdit(raw, { userId: draft.userId, draftId, oldText: clause.text, newText: now.text, program: view.program });
  }
  return view;
}

export async function screenProgramDraft(raw: Database.Database, draftId: number, asOf: string, fetchFn?: typeof fetch, table = false) {
  const { draft, defaults } = load(raw, draftId);
  const program = resolveProgram(draft.program!, defaults);
  const problems = programConfirmProblems(program);
  if (problems.length) throw new Error(`cannot run: ${problems.join("; ")}`);
  // user + draft ids are the tier-0 upload keys (data-fallback spec §9.4): an uploaded universe is used by the dry run
  return screenProgram(program, asOf, fetchFn, table, { userId: draft.userId, promptId: draftId });
}

// Non-blocking data check for the interpretation chips (spec §6.2): what each condition and the universe would run on.
export async function feasibilityProgramDraft(raw: Database.Database, draftId: number, asOf: string, fetchFn?: typeof fetch) {
  const { draft, defaults } = load(raw, draftId);
  const program = resolveProgram(draft.program!, defaults);
  return feasibility(program, asOf, { userId: draft.userId, promptId: draftId }, fetchFn) as Promise<{ feasibility: import("@/server/engine/client").Feasibility }>;
}

export const MAX_UPLOAD_CHARS = 2_000_000;
// The optional escape hatch next to an approx/unavailable chip: a universe CSV (a `symbol` column) used as tier 0 for this draft.
export async function uploadForDraft(raw: Database.Database, draftId: number, name: string, text: string, fetchFn?: typeof fetch) {
  const draft = getDraft(raw, draftId);
  if (!draft) throw new Error(`draft ${draftId} not found`);
  if (text.length > MAX_UPLOAD_CHARS) throw new Error("file too large (max 2 MB)");
  return uploadUniverse(draft.userId, draftId, name, text, fetchFn);
}

export { resolvedJson };
