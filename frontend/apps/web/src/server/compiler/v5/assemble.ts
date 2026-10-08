// Steps 5–6 — assemble the program from clause fragments (sets, references, ids, timeframe scope,
// eval mode), then walk it against the registry for needs_input. Deterministic; no model involved.
import type { ScreenProgram } from "spec";
import { INDICATORS } from "./registry";
import type { ActionFrag, CondFrag, Fragment, Leaf, Need, Span, Tf } from "./recognisers";
import type { Clause } from "./segment";

type Cond = ScreenProgram["conditions"][number];
type SetDef = ScreenProgram["sets"][number];
type Action = ScreenProgram["actions"][number] & Record<string, any>;

export type ClauseResult = { clause: Clause; fragments: Fragment[]; viaModel?: boolean };
export type Assembled = {
  program: ScreenProgram;
  // clause id -> what it compiled to, plus how many questions it raised (for the interpretation view)
  trace: Map<string, { maps: string[]; questions: number; ignored?: string }>;
};

const nice = (ids: string[]) => ids.join(" + ");

export function assemble(results: ClauseResult[], norm: string): Assembled {
  const conds: Cond[] = [];
  const sets: SetDef[] = [];
  const actions: Action[] = [];
  const leaves: { path: string; phrase: string; span: Span }[] = [];
  const needs: { n: Need & { path: string }; clauseId: string }[] = [];
  const unsupported: ScreenProgram["unsupported"] = [];
  const ignored: ScreenProgram["ignored"] = [];
  const unrecognised: ScreenProgram["unrecognised"] = [];
  const trace: Assembled["trace"] = new Map();
  let universe: ScreenProgram["universe"] = { source: "nse_all" };
  let universeSeen = false;
  let scope: { tf: Tf; mode: "literal" | "latest" } | null = null;
  const meta = new Map<string, { clauseId: string; clauseNumber: number | null; phrase: string; field: boolean; clauseText: string }>();
  const byNumber = new Map<number, string[]>();   // clause number -> condition ids it produced
  let baseId: string | null = null;
  const baseLabel: { text: string | null } = { text: null };

  const addTrace = (id: string, map: string) => {
    const t = trace.get(id) ?? { maps: [], questions: 0 };
    t.maps.push(map); trace.set(id, t);
  };
  const addNeed = (clauseId: string, n: Need & { path: string }) => {
    needs.push({ n, clauseId });
    const t = trace.get(clauseId) ?? { maps: [], questions: 0 };
    t.questions += 1; trace.set(clauseId, t);
  };
  const signalIds = () => conds.filter((c) => !meta.get(c.id)!.field).map((c) => c.id);
  const fieldIds = () => conds.filter((c) => meta.get(c.id)!.field).map((c) => c.id);
  const evalFor = (ids: string[]): SetDef["eval"] | undefined => {
    const tfs = new Set(ids.map((id) => (conds.find((c) => c.id === id)!.lhs as any).tf).filter(Boolean));
    if (ids.length === 0) return undefined;
    const tf = tfs.size === 1 ? ([...tfs][0] as Tf) : scope?.tf ?? null;
    return { mode: tf === "1D" ? "latest" : "literal", timeframe: tf, bar: "last_completed" };
  };
  const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
  const whereIds = (s: SetDef): string[] => ((s.where as any).all ?? []) as string[];

  function ensureBase(): string | null {
    if (baseId) return baseId;
    const f = fieldIds();
    if (f.length === 0) return null;
    baseId = `S${sets.length + 1}`;
    sets.push({ id: baseId, from: "universe", label: baseLabel.text ?? undefined, where: { all: f } });
    return baseId;
  }
  function ensureSet(ids: string[], label: string): string {
    const base = ensureBase();
    const own = ids.filter((id) => !meta.get(id)!.field);
    const hit = sets.find((s) => s.id !== baseId && sameIds(whereIds(s), own) && s.from === (base ?? "universe"));
    if (hit) return hit.id;
    const id = `S${sets.length + 1}`;
    sets.push({ id, from: base ?? "universe", label, eval: evalFor(own), where: { all: own } });
    return id;
  }
  const qualified = () => ensureSet(signalIds(), "qualified stocks");
  const phraseOf = (ids: string[]) => ids.map((id) => meta.get(id)!.phrase).join(" and ");

  function resolveSet(a: ActionFrag, clauseId: string, aid: string): { set: string | null; extra: (Need & { path: string })[] } {
    const extra: (Need & { path: string })[] = [];
    const sig = signalIds();
    switch (a.ref.type) {
      case "qualified": return { set: sig.length ? qualified() : ensureBase(), extra };
      case "number": {
        const ids = byNumber.get(a.ref.n) ?? [];
        const own = ids.filter((id) => !meta.get(id)!.field);
        if (own.length === 0) return { set: ensureBase() ?? (sig.length ? qualified() : null), extra };
        return { set: ensureSet(own, `stocks from step ${a.ref.n}`), extra };
      }
      case "description": {
        const ref = a.ref.text.toLowerCase().replace(/\s+/g, " ");
        const matched = sig.filter((id) => ref.includes(meta.get(id)!.phrase.toLowerCase().replace(/\s+/g, " ")));
        if (matched.length === 0) {
          extra.push({ path: `actions.${aid}.set`, reason: "missing", phrase: a.ref.text,
            options: sets.map((s) => ({ label: `${s.id}: ${s.label ?? "stocks"}`, value: s.id })) });
          return { set: null, extra };
        }
        const label = /^stocks\b/i.test(a.ref.text) ? a.ref.text : `stocks ${a.ref.text}`;
        const descSet = ensureSet(matched, label);
        const dropped = sig.filter((id) => !matched.includes(id));
        if (dropped.length > 0) {
          const qSet = qualified();
          extra.push({ path: `actions.${aid}.set`, reason: "ambiguous", phrase: a.ref.text, options: [
            { label: `all ${label} (${phraseOf(matched)})`, value: descSet },
            { label: `only qualified stocks (${phraseOf(sig)})`, value: qSet },
          ] });
        }
        return { set: descSet, extra };
      }
      default: {
        if (sig.length) return { set: sets.length > 0 && sets[sets.length - 1].id !== baseId ? sets[sets.length - 1].id : qualified(), extra };
        return { set: ensureBase(), extra };
      }
    }
  }

  for (const { clause, fragments, viaModel } of results) {
    const id = clause.id;
    if (fragments.length === 0) {
      unrecognised.push({ clause_id: id, text: clause.text, span: [clause.start, clause.end] });
      trace.set(id, { maps: [], questions: 0 });
      continue;
    }
    const produced: string[] = [];
    for (const f of fragments) {
      if (f.kind === "link") {
        addTrace(id, f.note);
      } else if (f.kind === "unsupported") {
        unsupported.push({ text: f.text, reason: f.reason });
        addTrace(id, f.reason);
      } else if (f.kind === "noise") {
        ignored.push({ text: clause.text, reason: f.reason });
        trace.set(id, { maps: [], questions: 0, ignored: f.reason });
      } else if (f.kind === "scope") {
        scope = { tf: f.tf, mode: f.mode };
        addTrace(id, `${f.tf === "1D" ? "daily" : f.tf === "1W" ? "weekly" : "monthly"} bars (applies to the lines below)`);
      } else if (f.kind === "universe") {
        universe = f.universe; universeSeen = true;
        f.leaves.forEach((l) => leaves.push({ ...l }));
        addTrace(id, f.universe.source === "index" ? `universe: ${f.universe.index}` : "universe: all NSE stocks");
      } else if (f.kind === "condition") {
        const cid = `C${conds.length + 1}`;
        const isField = "field" in f.lhs;
        const lhs: any = isField ? f.lhs : { ...f.lhs, tf: (f.lhs as any).tf ?? scope?.tf ?? null };
        const rhs: any = f.rhs ? { ...f.rhs, tf: f.rhs.tf ?? scope?.tf ?? null } : f.rhs;
        const c: Cond = { id: cid, lhs, op: f.op, ...(f.value !== undefined ? { value: f.value } : {}), ...(rhs !== undefined ? { rhs } : {}),
          ...(f.dir ? { dir: f.dir } : {}), ...(f.within_bars !== undefined ? { within_bars: f.within_bars } : {}),
          ...(f.emit ? { emit: f.emit } : {}), phrase: f.phrase };
        conds.push(c);
        meta.set(cid, { clauseId: id, clauseNumber: clause.number, phrase: f.phrase, field: isField, clauseText: clause.text });
        produced.push(cid);
        f.leaves.forEach((l) => leaves.push({ ...l, path: `conditions.${cid}.${l.path}` }));
        f.needs.forEach((n) => addNeed(id, { ...n, path: `conditions.${cid}.${n.path}` }));
        if (isField && baseLabel.text === null) baseLabel.text = clause.text;
        addTrace(id, `${cid}: ${describeCond(c)}`);
      } else {
        const aid = `A${actions.length + 1}`;
        if (f.ref.type === "description" && f.ref.stray) ignored.push({ text: f.ref.stray, reason: "stray word after a set reference" });
        const { set, extra } = resolveSet(f, id, aid);
        const a = buildAction(f, aid, set, conds, meta, (n) => addNeed(id, n), leaves, id);
        actions.push(a);
        extra.forEach((n) => addNeed(id, n));
        addTrace(id, `${aid}: ${describeAction(a, sets)}`);
      }
    }
    if (produced.length && clause.number !== null) byNumber.set(clause.number, [...(byNumber.get(clause.number) ?? []), ...produced]);
    if (viaModel) { const t = trace.get(id); if (t) t.maps.push("(read by the local model)"); }
  }

  // Make sure the final program has a set that selects on every signal condition.
  const sig = signalIds();
  if (sig.length > 0 && !sets.some((s) => sameIds(whereIds(s).filter((x) => !meta.get(x)!.field), sig))) qualified();
  else if (sig.length === 0 && conds.length > 0) ensureBase();
  // rank on an event_date needs the cross condition to emit it
  actions.filter((a) => a.type === "rank").forEach((a) => {
    const s = sets.find((x) => x.id === a.set);
    const key = (a.by?.[0]?.key as string | undefined)?.split(".")[0];
    const c = conds.find((x) => x.id === key) ?? conds.find((x) => whereIds(s ?? ({ where: { all: [] } } as any)).includes(x.id) && x.rhs);
    if (c && a.by) {
      a.by[0].key = `${c.id}.event_date`;
      c.emit = Array.from(new Set([...(c.emit ?? []), "event_date" as const]));
    }
  });

  const gap = gapAnalysis(conds, actions);
  const allNeeds = [...needs.filter((n) => !n.n.path.startsWith("actions.")).map((x) => x.n), ...gap.map((g) => g.n),
                    ...needs.filter((n) => n.n.path.startsWith("actions.")).map((x) => x.n)];
  gap.forEach((g) => { const cid = meta.get(g.condId)?.clauseId; if (cid) { const t = trace.get(cid)!; t.questions += 1; } });
  if (!universeSeen && conds.length > 0) allNeeds.unshift({ path: "universe.source", reason: "missing" });
  const seen = new Set<string>();
  const needs_input = allNeeds.filter((n) => (seen.has(n.path) ? false : (seen.add(n.path), true)))
    .map((n) => ({ ...n, path: n.path }));

  const program: ScreenProgram = {
    program_version: 5, universe, sets, conditions: conds, actions: actions as any,
    source_phrases: leaves.filter((l) => !isNull(l)).map((l) => ({ path: l.path, phrase: l.phrase, span: l.span })),
    needs_input, unsupported, ignored, unrecognised, answers: [],
  };
  return { program, trace };
}

const isNull = (_l: Leaf) => false;

function buildAction(f: ActionFrag, aid: string, set: string | null, conds: Cond[], meta: Map<string, any>,
                     need: (n: Need & { path: string }) => void, leaves: { path: string; phrase: string; span: Span }[], clauseId: string): Action {
  const base: any = { id: aid, type: f.action, set };
  const P = (p: string) => `actions.${aid}.${p}`;
  if (set === null && f.action !== "validate") need({ path: P("set"), reason: "missing" });
  if (f.action === "group_by") {
    base.key = "sector";
    if (f.highlight) { base.highlight = { metric: null, rule: null }; need({ path: P("highlight.metric"), reason: "missing" }); }
  } else if (f.action === "trade_plan") {
    if (f.hasEP) { base.entry = { at: null }; need({ path: P("entry.at"), reason: "missing" }); }
    if (f.hasSL) {
      const s = (base.set as string) ?? null;
      const inSet = conds.filter((c) => "ind" in c.lhs && INDICATORS[(c.lhs as any).ind]?.can_supply_stop);
      base.stop = { from: inSet.length === 1 ? inSet[0].id : null };
      if (inSet.length !== 1) need({ path: P("stop.from"), reason: "missing", options: inSet.map((c) => ({ label: `${c.id}: ${c.phrase}`, value: c.id })) });
      void s;
    }
    if (f.hasConfidence) { base.confidence = { method: null }; need({ path: P("confidence.method"), reason: "missing" }); }
  } else if (f.action === "validate") {
    base.of = "program";
    base.shift = { weeks: f.shift ? -1 : null };
    if (f.shift) leaves.push({ ...f.shift, path: P("shift.weeks") }); else need({ path: P("shift.weeks"), reason: "missing" });
    base.horizons_w = f.horizons ? f.horizons.value : null;
    if (f.horizons) leaves.push({ ...f.horizons.leaf, path: P("horizons_w") }); else need({ path: P("horizons_w"), reason: "missing" });
    delete base.set;
  } else if (f.action === "rank") {
    base.by = f.rankKey ? [{ key: "?.event_date", order: f.rankOrder ?? "desc" }] : [];
    if (!f.rankKey) need({ path: P("by"), reason: "missing" });
  } else if (f.action === "limit") {
    base.n = f.n!.value; leaves.push({ ...f.n!.leaf, path: P("n") });
  }
  void clauseId; void meta;
  return base;
}

// Step 6 — gap analysis: every param the registry requires that the prompt did not state.
export function gapAnalysis(conds: Cond[], _actions: Action[]): { n: Need & { path: string }; condId: string }[] {
  const out: { n: Need & { path: string }; condId: string }[] = [];
  for (const c of conds) {
    const operands: [string, any][] = [["", c.lhs], ["rhs.", c.rhs]];
    for (const [prefix, o] of operands) {
      if (!o) continue;
      if ("ind" in o) {
        const reg = INDICATORS[o.ind];
        for (const p of reg?.required_params ?? []) {
          if (o.params[p.name] === null || o.params[p.name] === undefined) out.push({ n: { path: `conditions.${c.id}.${prefix}params.${p.name}`, reason: "missing" }, condId: c.id });
        }
        if (prefix === "" && o.tf === null) out.push({ n: { path: `conditions.${c.id}.tf`, reason: "missing" }, condId: c.id });
      } else if (o.field === "traded_value_cr" && !o.params?.window) {
        out.push({ n: { path: `conditions.${c.id}.params.window`, reason: "missing" }, condId: c.id });
      }
    }
    if (Array.isArray(c.value)) {
      c.value.forEach((v, i) => { if (v === null || v === undefined) out.push({ n: { path: `conditions.${c.id}.value.${i}`, reason: "missing" }, condId: c.id }); });
    }
    if (c.op === null) { /* contradiction already raised by the recogniser */ }
    else if (c.value === undefined && !c.rhs && !["flip", "cross_above", "cross_below", "cross_any", "rising", "falling"].includes(c.op)) {
      out.push({ n: { path: `conditions.${c.id}.value`, reason: "missing" }, condId: c.id });
    }
  }
  return out;
}

const OPW: Record<string, string> = { "<": "<", ">": ">", ">=": "≥", "<=": "≤", between: "between", outside: "outside", flip: "flips", cross_above: "crosses above", cross_below: "crosses below", cross_any: "crosses (either way)" };
const q = (v: unknown) => (v === null || v === undefined ? "?" : typeof v === "number" && Math.abs(v) >= 1000 ? v.toLocaleString("en-IN") : String(v));

function describeOperand(o: any): string {
  if (!o) return "?";
  if ("field" in o) return ({ mcap_cr: "Market cap", traded_value_cr: "Traded value", price: "Price", volume: "Volume", sector: "Sector" } as any)[o.field] ?? o.field;
  const reg = INDICATORS[o.ind];
  const params = (reg?.required_params ?? []).map((p) => q(o.params[p.name])).join(", ");
  return `${reg?.label ?? o.ind}(${params})`;
}
export function describeCond(c: Cond): string {
  const unit = "field" in c.lhs && c.lhs.field === "mcap_cr" ? " cr" : "";
  const tf = "ind" in c.lhs && c.lhs.tf ? ` [${c.lhs.tf}]` : "";
  const v = Array.isArray(c.value) ? `${q(c.value[0])}–${q(c.value[1])}${unit}` : c.value === undefined || c.value === null ? (c.rhs ? describeOperand(c.rhs) : "") : `${q(c.value)}${unit}`;
  if (c.op === null) return `${describeOperand(c.lhs)} — comparison unclear`;
  if (c.op === "flip") return `${describeOperand(c.lhs)}${tf} flips ${c.dir ?? ""}`.trim();
  return `${describeOperand(c.lhs)}${tf} ${OPW[c.op] ?? c.op} ${v}`.trim();
}
export function describeAction(a: Action, sets: SetDef[]): string {
  const s = sets.find((x) => x.id === a.set);
  const on = s ? `${s.id} (${((s.where as any).all as string[]).join(" + ")})` : "?";
  switch (a.type) {
    case "group_by": return `group ${on} by sector${a.highlight ? ", highlight outperformers" : ""}`;
    case "trade_plan": return `trade plan on ${on}${a.stop ? `, SL from ${a.stop.from ?? "?"}` : ""}`;
    case "validate": return `re-run ${a.shift?.weeks ? Math.abs(a.shift.weeks) + " week back" : "?"}, measure ${a.horizons_w ? a.horizons_w.join("/") + "-week" : "?"} return`;
    case "rank": return `rank ${on}${a.by?.[0] ? ` by ${a.by[0].key} ${a.by[0].order}` : ""}`;
    case "limit": return `top ${a.n} of ${on}`;
    default: return a.type;
  }
}
