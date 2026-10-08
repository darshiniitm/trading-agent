// The interpreter orchestrator (plan §3): a fixed, deterministic pipeline. Models are used in exactly two
// steps — Reader (whole prompt, only for lines the tools could not read) and Critic (compare two texts).
//   1 pre-annotate  2 reader  3 grounder  4 slot resolver  5 verifier  6 critic (≤ 2 rounds back to 2)  7 dry run
// Steps 1, 3, 4, 5 live inside compileProgram; this file adds the loop, the rendering and the report.
import type { ClauseView, ScreenProgram } from "spec";
import type { UserDefaults } from "@/server/userDefaults";
import { compileProgram, type ProgramDraft } from "./compileProgram";
import { coverage, type Coverage } from "./coverage";
import { ruleCritic, type CriticFn, type Issue } from "./critic";
import { dryRun, type DryRun } from "./dryRun";
import type { Example, ReaderFn } from "./reader";
import { renderEnglish } from "./render";
import { toFiveSlots, type FiveSlots, type RankSlot } from "./slots5";
import type { Fragment } from "./recognisers";

export type InterpretOptions = {
  defaults?: UserDefaults; reader?: ReaderFn; critic?: CriticFn; examples?: Example[];
  fallback?: (text: string, start: number) => Promise<Fragment[]>;
  maxRounds?: number;
  dryRun?: { asOf: string; screen?: Parameters<typeof dryRun>[2]; fetchFn?: typeof fetch };
};
export type Interpretation = {
  draft: ProgramDraft; program: ScreenProgram; clauses: ClauseView[]; english: string;
  slots: { conditions: FiveSlots[]; rank: RankSlot[] };
  issues: Issue[]; rounds: number; coverage: Coverage; dryRun?: DryRun;
  reader: { calls: number; dropped: string[] };
};

const key = (i: Issue) => `${i.kind}|${i.phrase.toLowerCase()}`;

export async function interpret(text: string, opts: InterpretOptions = {}): Promise<Interpretation> {
  const maxRounds = opts.maxRounds ?? 2;
  let issuesForReader: string[] | undefined;
  let best: { draft: ProgramDraft; english: string; issues: Issue[] } | null = null;
  const reader = { calls: 0, dropped: [] as string[] };
  let rounds = 0;

  for (let round = 0; round <= maxRounds; round++) {
    const draft = await compileProgram(text, { defaults: opts.defaults, reader: opts.reader, readerIssues: issuesForReader, examples: opts.examples, fallback: opts.fallback });
    reader.calls += draft.reader?.calls ?? 0; reader.dropped.push(...(draft.reader?.dropped ?? []));
    const english = renderEnglish(draft.program);
    const found = new Map<string, Issue>();
    for (const i of ruleCritic(draft.normalised, draft.clauses, draft.program)) found.set(key(i), i);
    // the model critic only runs when a model already read part of the prompt, or the rules found something to check
    if (opts.critic && (draft.modelCalls > 0 || found.size > 0)) for (const i of await opts.critic(draft.normalised, english)) found.set(key(i), i);
    const issues = [...found.values()];
    // fewer problems wins; a line still unread counts as one
    const score = (d: ProgramDraft, n: number) => n + d.clauses.filter((c) => c.status === "not_understood").length;
    if (!best || score(draft, issues.length) < score(best.draft, best.issues.length)) best = { draft, english, issues };
    rounds = round;
    // another round only helps if a model reading can still change something: there is a Reader and lines it can still fill
    const canRetry = !!opts.reader && draft.clauses.some((c) => c.status === "not_understood");
    if (issues.length === 0 || round === maxRounds || !canRetry) break;
    issuesForReader = issues.map((i) => `${i.kind}: "${i.phrase}" — ${i.note}`);
  }

  const { draft, english, issues } = best!;
  // the issues that survive are shown on the line they point at
  const clauses = draft.clauses.map((c) => {
    const mine = issues.filter((i) => c.text.toLowerCase().includes(i.phrase.toLowerCase()));
    return mine.length ? { ...c, maps_to: `${c.maps_to} ⚠ ${mine.map((i) => `${i.kind}: ${i.note}`).join("; ")}` } : c;
  });
  return {
    draft, program: draft.program, clauses, english, slots: toFiveSlots(draft.program), issues, rounds,
    coverage: coverage(draft.clauses), reader,
    ...(opts.dryRun ? { dryRun: await dryRun(draft.program, opts.dryRun.asOf, opts.dryRun.screen, opts.dryRun.fetchFn) } : {}),
  };
}
