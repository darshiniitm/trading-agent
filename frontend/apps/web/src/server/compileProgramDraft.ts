import type { Db } from "@/server/db/pg";
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
import { makeModelReader } from "@/server/compiler/v5/modelRead";
import { applyChipEdit, resolveProgram } from "@/server/compiler/v5/resolve";
import { resolvedJson, toSlotConditions, type SlotCondition } from "@/server/compiler/v5/slots";
import { getUserDefaults, type UserDefaults } from "@/server/userDefaults";
import { feasibility, screenProgram, uploadUniverse } from "@/server/engine/client";
import { getDraft, saveProgramState, updateDraft, type DraftRow } from "@/server/drafts";
import { agent, task, tool } from "@/server/telemetry";
import { inPromptRun } from "@/server/telemetry/run";
import { buildFallbackPrompt } from "@/server/compiler/v5/fallback";
import { buildModelPrompt } from "@/server/compiler/v5/modelRead";
import { buildReaderPrompt } from "@/server/compiler/v5/reader";

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
  // the local model could not be reached: the rules' reading stands and unread words are flagged (start Ollama and re-interpret)
  modelError?: string;
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

const defaultsOf = (raw: Db, userId: number) => getUserDefaults(raw, userId);

// Compile the draft's prompt text to a v5 program. Recognisers do the parsing; the model (if given)
// only sees lines no recogniser claimed, one schema-constrained call per line. Every slot the prompt left
// open is then filled from the user's saved defaults and listed as a chip — nothing is asked.
// observability (docs/production-llm-cloud-observability-plan.md): spans / rows are no-ops unless telemetry is installed.
// agent_version = hash of the agent's static system prompt, so a prompt change shows up as a new version in Grafana.
const staticText = (f: () => string) => { try { return f(); } catch { return ""; } };
const AGENT_PROMPTS = {
  clause_fallback: () => staticText(() => buildFallbackPrompt("").system),
  model_reader: () => staticText(() => buildModelPrompt("", [], "", []).system),
  reader: () => staticText(() => buildReaderPrompt({ norm: "", clauses: [], unresolved: [], found: [], annotations: [] }).system),
  model_critic: () => makeModelCritic.toString(),
};
const tracedInterpret = task("interpret", interpret, { spanName: "interpreter.parse" });
const tracedSave = tool("warehouse.write", saveProgramState, { argsOf: (_raw, draftId) => ({ table: "prompt_drafts", draft_id: draftId }), captureInput: false, captureOutput: false });
// inPromptRun opens its span synchronously, so the draft is read first and handed over.
const lookupOf = async (raw: Db, draftId: number) => { const d = await getDraft(raw, draftId); return () => ({ userId: d?.userId, createdAt: d?.createdAt }); };

export async function compileProgramDraft(raw: Db, draftId: number, opts: { callModel?: CallModelFn; useModel?: boolean } = {}): Promise<ProgramView> {
  return inPromptRun({ draftId, stage: "compile", lookup: await lookupOf(raw, draftId) }, () => compileProgramDraftInner(raw, draftId, opts));
}

async function compileProgramDraftInner(raw: Db, draftId: number, { callModel, useModel = true }: { callModel?: CallModelFn; useModel?: boolean } = {}): Promise<ProgramView> {
  const draft = await getDraft(raw, draftId);
  if (!draft) throw new Error(`draft ${draftId} not found`);
  if (!draft.promptText.trim()) throw new Error("draft has no prompt text yet");
  const defaults = await defaultsOf(raw, draft.userId);
  const examples: Example[] = useModel ? await similarExamples(raw, draft.promptText, 4) : [];
  const r = await tracedInterpret(draft.promptText, {
    defaults,
    fallback: useModel ? agent("clause_fallback", makeClauseFallback(callModel), { versionOf: AGENT_PROMPTS.clause_fallback() }) : undefined,
    modelRead: useModel ? agent("model_reader", makeModelReader(callModel), { versionOf: AGENT_PROMPTS.model_reader() }) : undefined,
    reader: useModel ? agent("reader", makeReader(callModel), { versionOf: AGENT_PROMPTS.reader() }) : undefined,
    critic: useModel ? agent("model_critic", makeModelCritic(callModel), { versionOf: AGENT_PROMPTS.model_critic() }) : undefined,
    examples,
  });
  const view = viewOf(await tracedSave(raw, draftId, { program: r.program, clauses: r.draft.clauses, normalised: r.draft.normalised }), defaults);
  // the model critic's issues are not stored with the draft; they ride along on this response
  return { ...view, issues: r.issues, reader: r.reader, ...(r.draft.modelError ? { modelError: r.draft.modelError } : {}) };
}

async function load(raw: Db, draftId: number) {
  const draft = await getDraft(raw, draftId);
  if (!draft?.program) throw new Error(`draft ${draftId} has no compiled program yet`);
  return { draft, defaults: await defaultsOf(raw, draft.userId) };
}

// Editing a chip replaces one assumed value; the rest of the program is untouched and the screen can re-run.
export async function editChip(raw: Db, draftId: number, path: string, value: unknown): Promise<ProgramView> {
  const { draft, defaults } = await load(raw, draftId);
  const before = (resolveProgram(draft.program!, defaults).assumptions ?? []).find((a) => a.path === path);
  const program = applyChipEdit(resolveProgram(draft.program!, defaults), path, value, defaults);
  await recordEdit(raw, { userId: draft.userId, draftId, phrase: before?.label ?? path, from: before?.value, to: value, path });
  return viewOf(await saveProgramState(raw, draftId, { program, clauses: draft.programClauses }), defaults);
}

export type AddonChoice = { liquidity: LiquidityChoice } | { min_price: { mode: "none" } | { mode: "floor"; price: number } };
// Optional add-ons are off until switched on; switching one on adds an ordinary condition to the base set.
export async function setAddon(raw: Db, draftId: number, choice: AddonChoice): Promise<ProgramView> {
  const { draft, defaults } = await load(raw, draftId);
  const base = resolveProgram(draft.program!, defaults);
  const program = "liquidity" in choice ? applyLiquidity(base, choice.liquidity) : applyMinPrice(base, choice.min_price);
  return viewOf(await saveProgramState(raw, draftId, { program, clauses: draft.programClauses }), defaults);
}

// Editing a line rewrites that line in the (normalised) prompt text and recompiles. Earlier chip edits are
// dropped — they were edits to the old wording.
export async function editProgramClause(raw: Db, draftId: number, clauseId: string, text: string, opts: { callModel?: CallModelFn; useModel?: boolean } = {}): Promise<ProgramView> {
  const draft = await getDraft(raw, draftId);
  const clause = draft?.programClauses?.find((c) => c.id === clauseId);
  if (!draft || !clause || draft.programNormalised == null) throw new Error("clause not found");
  const norm = draft.programNormalised;
  const edited = norm.slice(0, clause.span[0]) + text.replace(/\n/g, " ").trim() + norm.slice(clause.span[1]);
  await updateDraft(raw, draftId, { promptText: edited });
  const view = await compileProgramDraft(raw, draftId, opts);
  // the old wording, rewritten by the user into something that now compiles, may become an alias proposal
  const now = view.clauses.find((c) => c.id === clauseId);
  if (clause.status === "not_understood" && now && now.status !== "not_understood") {
    await learnFromClauseEdit(raw, { userId: draft.userId, draftId, oldText: clause.text, newText: now.text, program: view.program });
  }
  return view;
}

const tracedScreen = task("screen", screenProgram);
export async function screenProgramDraft(raw: Db, draftId: number, asOf: string, fetchFn?: typeof fetch, table = false) {
  return inPromptRun({ draftId, stage: "screen", lookup: await lookupOf(raw, draftId) }, () => screenProgramDraftInner(raw, draftId, asOf, fetchFn, table));
}

async function screenProgramDraftInner(raw: Db, draftId: number, asOf: string, fetchFn?: typeof fetch, table = false) {
  const { draft, defaults } = await load(raw, draftId);
  const program = resolveProgram(draft.program!, defaults);
  const problems = programConfirmProblems(program);
  if (problems.length) throw new Error(`cannot run: ${problems.join("; ")}`);
  // user + draft ids are the tier-0 upload keys (data-fallback spec §9.4): an uploaded universe is used by the dry run
  return tracedScreen(program, asOf, fetchFn, table, { userId: draft.userId, promptId: draftId });
}

// Non-blocking data check for the interpretation chips (spec §6.2): what each condition and the universe would run on.
export async function feasibilityProgramDraft(raw: Db, draftId: number, asOf: string, fetchFn?: typeof fetch) {
  const { draft, defaults } = await load(raw, draftId);
  const program = resolveProgram(draft.program!, defaults);
  return feasibility(program, asOf, { userId: draft.userId, promptId: draftId }, fetchFn) as Promise<{ feasibility: import("@/server/engine/client").Feasibility }>;
}

export const MAX_UPLOAD_CHARS = 2_000_000;
// The optional escape hatch next to an approx/unavailable chip: a universe CSV (a `symbol` column) used as tier 0 for this draft.
export async function uploadForDraft(raw: Db, draftId: number, name: string, text: string, fetchFn?: typeof fetch) {
  const draft = await getDraft(raw, draftId);
  if (!draft) throw new Error(`draft ${draftId} not found`);
  if (text.length > MAX_UPLOAD_CHARS) throw new Error("file too large (max 2 MB)");
  return uploadUniverse(draft.userId, draftId, name, text, fetchFn);
}

export { resolvedJson };
