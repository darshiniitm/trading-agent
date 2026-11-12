import type { ClauseView, ScreenProgram } from "spec";
import { assemble, describeAction, type ClauseResult } from "./assemble";
import { normalise } from "./normalise";
import { recogniseWithCoverage, type CondFrag } from "./recognisers";
import { leftoverOf, pieces as piecesOf } from "./leftover";
import { clauseTimeframe } from "./patterns";
import { linkClauses, type RawResult } from "./link";
import { notComputable } from "./notComputable";
import { preannotate } from "./preannotate";
import type { Example, ReaderFn } from "./reader";
import { segment } from "./segment";
import { verifyProgram } from "./verify";
import { resolveProgram } from "./resolve";
import { tool } from "@/server/telemetry";

// observability: the pure default-filling / assumption-chip step, traced only on the compile path (resolveProgram is also called from viewOf on every read)
const tracedResolve = tool("conditions.resolve", resolveProgram);
import { BUILTIN_DEFAULTS, type UserDefaults } from "@/server/userDefaults";

export type ProgramDraft = {
  normalised: string; program: ScreenProgram; clauses: ClauseView[]; modelCalls: number;
  reader?: { calls: number; dropped: string[] };
  modelError?: string;     // the local model could not be reached; the rules' reading stands and unread words are flagged
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
  // the local model, asked about the words the recognisers left unread (modelRead.ts)
  modelRead?: import("./modelRead").ModelReadFn;
};

// Does a produced rule say the same thing as one already read? (the model may restate what the rules read)
/** A crossover is only a signal if the first line is still on the far side today: add that comparison when the reading
 *  (rules or model) did not (the golden-cross / MACD / RSI-level readings all mean "crossed ... and is still above"). */
function withCompanions(frags: import("./recognisers").RawFragment[]): import("./recognisers").RawFragment[] {
  const conds = frags.filter((f): f is CondFrag => f.kind === "condition");
  const have = new Set(conds.map(ruleKey));
  const extra: CondFrag[] = [];
  for (const f of conds) {
    if ((f.op !== "cross_above" && f.op !== "cross_below") || !("ind" in f.lhs)) continue;
    const op = f.op === "cross_above" ? ">" : "<";
    const c: CondFrag = { ...f, op, within_bars: undefined, emit: undefined, dir: undefined,
      leaves: f.leaves.filter((l) => l.path !== "within_bars"), implied: (f.implied ?? []).filter((i) => i.path !== "within_bars") };
    delete c.within_bars; delete c.emit; delete c.dir;
    if (!have.has(ruleKey(c))) { have.add(ruleKey(c)); extra.push(c); }
  }
  return extra.length ? [...frags, ...extra] : frags;
}

// ... or the same two operands compared a different way (a small model restating "close above the high" as ">=")
const operandsKey = (f: import("./recognisers").CondFrag) => JSON.stringify({ l: f.lhs, r: f.rhs ?? null }, (k, v) => (k === "tf" ? undefined : v));
const ruleKey = (f: import("./recognisers").CondFrag) => JSON.stringify({
  l: f.lhs, o: f.op, r: f.rhs ?? null, v: f.value ?? null, m: f.rhs_mult ?? null, w: f.within_bars ?? null, b: f.bars ?? null, d: f.dir ?? null,
}, (k, v) => (k === "tf" ? undefined : v));

export async function compileProgram(promptText: string, opts: CompileProgramOptions = {}): Promise<ProgramDraft> {
  const norm = normalise(promptText);
  const clauses = segment(norm);
  const raw: RawResult[] = [];
  let modelCalls = 0;
  let modelError: string | undefined;
  for (const clause of clauses) {
    const rec = recogniseWithCoverage(clause, opts.disabledRecognisers);
    let fragments: import("./recognisers").RawFragment[] = rec.fragments;
    let viaModel = false;
    // a named-but-uncomputable indicator is reported as such, and the model is not asked to guess at it
    const covered = fragments.filter((f): f is CondFrag => f.kind === "condition").map((f) => f.span);
    const unavailable = notComputable(clause, covered);
    if (fragments.length === 0 && unavailable.length > 0) fragments = unavailable;
    else if (unavailable.length > 0) fragments = [...fragments, ...unavailable];
    if (fragments.length === 0 && opts.fallback && !modelError) {
      modelCalls += 1;
      try {
        fragments = await opts.fallback(clause.text, clause.start);
        viaModel = fragments.length > 0;
      } catch (e) { modelError = (e as Error).message; }   // unreachable model / spent time budget: the line stays unread and is flagged
    }
    // words nothing read: ask the local model, one rule-sized piece at a time; whatever it cannot read is flagged, never silently dropped
    const hasUnsupported = fragments.some((f) => f.kind === "unsupported" || f.kind === "noise");
    const whole = leftoverOf(clause, rec.used, hasUnsupported);
    if (whole.ask || whole.flag) {
      const have = fragments.filter((f): f is CondFrag => f.kind === "condition");
      const seen = new Set(have.map(ruleKey)), shapes = new Set(have.filter((f) => f.rhs).map(operandsKey));
      for (const piece of piecesOf(clause, rec.used)) {
        const left = leftoverOf(piece.clause, piece.used, hasUnsupported);
        if (!left.ask && !left.flag) continue;
        let added = 0;
        if (opts.modelRead && !modelError) {
          try {
            modelCalls += 1;
            const sibling = have.map((f) => ("ind" in f.lhs ? f.lhs.tf : null)).find(Boolean) ?? null;
            const got = await opts.modelRead({ clause: piece.clause, leftover: left.text, understood: have.map((f) => f.phrase), timeframe: clauseTimeframe(clause.text) ?? sibling });
            for (const g of got) {
              if (seen.has(ruleKey(g)) || (g.rhs && shapes.has(operandsKey(g)))) continue;
              seen.add(ruleKey(g)); if (g.rhs) shapes.add(operandsKey(g)); fragments = [...fragments, g]; added++;
            }
          } catch (e) { modelError = (e as Error).message; }
        }
        if (added > 0) viaModel = true;
        else if (left.flag && fragments.length > 0) fragments = [...fragments, { kind: "unsupported", text: piece.clause.text, reason: `part of this line could not be turned into a rule: "${left.text.slice(0, 90)}"` }];
      }
    }
    raw.push({ clause, fragments: withCompanions(fragments), viaModel });
  }
  const results: ClauseResult[] = linkClauses(raw);
  let readerReport: ProgramDraft["reader"];
  const unresolved = results.filter((r) => r.fragments.length === 0);
  if (opts.reader && unresolved.length > 0) {
    const found = results.flatMap((r) => r.fragments).filter((f) => f.kind === "condition").map((f: any) => f.phrase as string);
    // like the per-line model reads above: a model that cannot be reached (or ran out of the request's time) leaves the rules' reading standing
    let out: Awaited<ReturnType<NonNullable<typeof opts.reader>>>;
    try {
      out = await opts.reader({ norm, clauses, unresolved: unresolved.map((r) => r.clause), found, annotations: preannotate(norm, clauses), issues: opts.readerIssues, examples: opts.examples });
    } catch (e) {
      modelError ??= (e as Error).message;
      out = { fragments: [], calls: 0, dropped: [] };
    }
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
  const program = opts.resolve === false ? verified : tracedResolve(verified, opts.defaults ?? BUILTIN_DEFAULTS);
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
  return { normalised: norm, program, clauses: views, modelCalls, ...(readerReport ? { reader: readerReport } : {}), ...(modelError ? { modelError } : {}) };
}

// An action's description was written before the interpreter filled its open values; say what it will actually do.
function redescribe(m: string, program: ScreenProgram): string {
  const id = /^(A\d+): /.exec(m)?.[1];
  const a = id ? program.actions.find((x) => x.id === id) : undefined;
  return id && a ? `${id}: ${describeAction(a as any, program.sets)}` : m;
}
