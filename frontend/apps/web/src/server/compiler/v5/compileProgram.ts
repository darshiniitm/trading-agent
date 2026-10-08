import type { ClauseView, ScreenProgram } from "spec";
import { assemble, describeAction, type ClauseResult } from "./assemble";
import { normalise } from "./normalise";
import { recognise } from "./recognisers";
import { linkClauses, type RawResult } from "./link";
import { notComputable } from "./notComputable";
import { preannotate } from "./preannotate";
import type { Example, ReaderFn } from "./reader";
import { segment } from "./segment";
import { verifyProgram } from "./verify";
import { resolveProgram } from "./resolve";
import { BUILTIN_DEFAULTS, type UserDefaults } from "@/server/userDefaults";

export type ProgramDraft = {
  normalised: string; program: ScreenProgram; clauses: ClauseView[]; modelCalls: number;
  reader?: { calls: number; dropped: string[] };
};

export type CompileProgramOptions = {
  disabledRecognisers?: ReadonlySet<string>;
  // the user's saved defaults, used to fill every slot the prompt leaves open (never asked)
  defaults?: UserDefaults;
  // false = stop after the compiler proper (open slots left as needs_input) — for tests of the compiler stage
  resolve?: boolean;
  // P4: per-clause model fallback for clauses no recogniser claimed
  // the Reader: one whole-prompt model call for the lines still unresolved after the tools (and the per-line fallback)
  reader?: ReaderFn; readerIssues?: string[]; examples?: Example[];
  fallback?: (clauseText: string, clauseStart: number) => Promise<import("./recognisers").Fragment[]>;
};

export async function compileProgram(promptText: string, opts: CompileProgramOptions = {}): Promise<ProgramDraft> {
  const norm = normalise(promptText);
  const clauses = segment(norm);
  const raw: RawResult[] = [];
  let modelCalls = 0;
  for (const clause of clauses) {
    let fragments: import("./recognisers").RawFragment[] = recognise(clause, opts.disabledRecognisers);
    let viaModel = false;
    // a named-but-uncomputable indicator is reported as such, and the model is not asked to guess at it
    const unavailable = notComputable(clause);
    if (fragments.length === 0 && unavailable.length > 0) fragments = unavailable;
    else if (unavailable.length > 0) fragments = [...fragments, ...unavailable];
    if (fragments.length === 0 && opts.fallback) {
      modelCalls += 1;
      fragments = await opts.fallback(clause.text, clause.start);
      viaModel = fragments.length > 0;
    }
    raw.push({ clause, fragments, viaModel });
  }
  const results: ClauseResult[] = linkClauses(raw);
  let readerReport: ProgramDraft["reader"];
  const unresolved = results.filter((r) => r.fragments.length === 0);
  if (opts.reader && unresolved.length > 0) {
    const found = results.flatMap((r) => r.fragments).filter((f) => f.kind === "condition").map((f: any) => f.phrase as string);
    const out = await opts.reader({ norm, clauses, unresolved: unresolved.map((r) => r.clause), found, annotations: preannotate(norm, clauses), issues: opts.readerIssues, examples: opts.examples });
    modelCalls += out.calls;
    const dropped = [...out.dropped];
    for (const f of out.fragments) {
      // a model reading may only fill a line the tools could not read; the tools' own reading always wins
      const target = f.kind === "condition" ? unresolved.find((r) => f.span[0] >= r.clause.start && f.span[0] <= r.clause.end) : undefined;
      if (target) {
        target.fragments.push(f); target.viaModel = true;
        // other unresolved lines the condition's values were read from ("Take the 6 day and 30 day averages") are read together with it
        for (const l of f.kind === "condition" ? f.leaves : []) {
          const src = unresolved.find((r) => r !== target && r.fragments.length === 0 && l.span[0] >= r.clause.start && l.span[1] <= r.clause.end);
          if (src) src.fragments.push({ kind: "link", note: `read together with line ${target.clause.id}` });
        }
      }
      else dropped.push(`${f.kind === "condition" ? f.phrase : f.kind}: not on an unresolved line`);
    }
    readerReport = { calls: out.calls, dropped };
  }
  const assembled = assemble(results, norm);
  const { trace } = assembled;
  // A failure here is a compiler bug (an untraceable value), never a user error: surface it loudly.
  const verified = verifyProgram(assembled.program, norm);
  const program = opts.resolve === false ? verified : resolveProgram(verified, opts.defaults ?? BUILTIN_DEFAULTS);
  const views: ClauseView[] = clauses.map((c) => {
    const t = trace.get(c.id);
    const unrec = verified.unrecognised.some((u) => u.clause_id === c.id);
    const viaModel = results.find((r) => r.clause.id === c.id)?.viaModel;
    return {
      id: c.id, text: c.text, span: [c.start, c.end],
      // no clause is ever a question any more: an open slot became an assumption chip, an unusable one is greyed out
      status: unrec ? "not_understood" : t?.ignored ? "ignored" : (t?.questions ?? 0) > 0 && opts.resolve === false ? "question" : viaModel ? "model" : "ok",
      maps_to: unrec ? (program.not_evaluable?.find((n) => n.id === c.id)?.reason ?? "not understood") : t?.ignored ? "ignored" : (t?.maps ?? []).map((m) => redescribe(m, program)).join("; "),
      questions: opts.resolve === false ? t?.questions ?? 0 : 0,
    };
  });
  return { normalised: norm, program, clauses: views, modelCalls, ...(readerReport ? { reader: readerReport } : {}) };
}

// An action's description was written before the interpreter filled its open values; say what it will actually do.
function redescribe(m: string, program: ScreenProgram): string {
  const id = /^(A\d+): /.exec(m)?.[1];
  const a = id ? program.actions.find((x) => x.id === id) : undefined;
  return id && a ? `${id}: ${describeAction(a as any, program.sets)}` : m;
}
