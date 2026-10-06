"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Condition, ScreenSpec, SelectionPoint, T1Window } from "spec";
import { ConditionRow } from "@/components/ConditionRow";
import { QuestionRow } from "@/components/QuestionRow";
import { describeApiError } from "@/lib/apiError";

type LiquidityChoice = "confirm_10cr" | "custom" | "none" | null;
type Structure = "literal" | "t1_literal";

// The shape a draft's spec_json can actually hold (drafts.ts's lenient
// DraftSpecSchema): structure may still be unresolved (null-structure
// compile), and selection_point/t1_window may be partially answered.
type DraftSpec = Omit<ScreenSpec, "structure" | "selection_point" | "t1_window"> & {
  structure: Structure | null;
  selection_point: Partial<SelectionPoint> | null;
  t1_window?: Partial<T1Window> | null;
};

type NeedsInput = { path: string; question: string };
type CompileView = {
  structure: Structure | null;
  spec: DraftSpec | null;
  needs_input: NeedsInput[];
  source_phrases: { path: string; phrase: string }[];
  unsupported: { text: string; reason: string }[];
};

type LoadedDraft = {
  status: string; structure: Structure | null; spec: DraftSpec | null;
  hypothesis: string | null; killCriterion: string | null; promptText?: string;
  needsInput?: NeedsInput[] | null;
  sourcePhrases?: { path: string; phrase: string }[] | null;
  unsupported?: { text: string; reason: string }[] | null;
};

type SaveResult = { ok: true; spec: DraftSpec } | { ok: false; error: string };

const LIQUIDITY_CONDITION_NAME = "traded_value_cr";

// The liquidity floor is appended by buildSpec() as a trailing
// traded_value_cr >= N (window 1W) filter; reverse that when loading a saved
// draft so it shows up as the liquidity answer, not as a free-form condition.
function isLiquidityCondition(c: Condition): boolean {
  return c.name === LIQUIDITY_CONDITION_NAME && c.op === ">=" && (c.params as any)?.window === "1W";
}

// Offsets are typed as a comma-separated list of integers; null means the
// text doesn't parse (the confirm gate reports it), [] means "left blank".
function parseOffsets(text: string): number[] | null {
  const parts = text.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (!parts.every((p) => /^-?\d+$/.test(p))) return null;
  return parts.map(Number);
}

// Used by /drafts/new (no initialDraftId: creates a fresh draft on mount) and
// by /drafts/[draftId] (loads that existing draft — e.g. an edit-as-new-version
// draft, or "Continue" from the Drafts tab — instead of creating a new one).
export function DraftEditor({ initialDraftId }: { initialDraftId?: number }) {
  const router = useRouter();
  const [draftId, setDraftId] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draftStatus, setDraftStatus] = useState<string | null>(null);
  const [structure, setStructure] = useState<Structure | "">("");
  const [conditions, setConditions] = useState<Condition[]>([]);
  const nextConditionNo = useRef(1); // monotonic — never reused, unlike conditions.length (removing then re-adding would collide)

  const [promptText, setPromptText] = useState("");
  const [compiling, setCompiling] = useState(false);
  const [compileResult, setCompileResult] = useState<CompileView | null>(null);
  const [compileError, setCompileError] = useState<string | null>(null);

  // No value below is pre-filled (D6): every parameter input starts empty and
  // is only ever filled from the user's own typing, a compiled/answered spec,
  // or a loaded draft.
  const [hasSelectionPoint, setHasSelectionPoint] = useState(false);
  const [sessionOfWeek, setSessionOfWeek] = useState("");
  const [selectionAt, setSelectionAt] = useState<"open" | "close" | "">("");
  const [stopFrom, setStopFrom] = useState("");
  const [hasRiskCap, setHasRiskCap] = useState(false);
  const [riskCapPct, setRiskCapPct] = useState("");
  const [hasNearMiss, setHasNearMiss] = useState(false);
  const [nearMissMaxFailed, setNearMissMaxFailed] = useState("");
  const [hasT1Window, setHasT1Window] = useState(false);
  const [t1LengthSessions, setT1LengthSessions] = useState("");
  const [t1OffsetsText, setT1OffsetsText] = useState("");

  const [liquidity, setLiquidity] = useState<LiquidityChoice>(null);
  const [liquidityCustom, setLiquidityCustom] = useState("");
  const [hypothesis, setHypothesis] = useState("");
  const [killCriterion, setKillCriterion] = useState("");

  const [dryRunResult, setDryRunResult] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);

  useEffect(() => {
    if (initialDraftId === undefined) {
      fetch("/api/drafts", { method: "POST" })
        .then((r) => r.json())
        .then((d) => setDraftId(d.draft_id));
      return;
    }
    fetch(`/api/drafts/${initialDraftId}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(describeApiError(body, `draft ${initialDraftId} could not be loaded`));
        return body;
      })
      .then((draft) => {
        loadDraft(draft);
        setDraftId(draft.draftId);
      })
      .catch((err: Error) => setLoadError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDraftId]);

  // The single place a spec (a loaded draft's, a fresh compile result, or the
  // spec returned after answering a question) is hydrated into the form, so
  // every path fills structure/conditions/selection point/stop/risk cap/near
  // miss/T1 window/liquidity — and advances nextConditionNo — identically.
  //
  // absentLiquidity: what a spec WITHOUT a trailing liquidity condition says
  // about the liquidity question. Only a spec that went through buildSpec()
  // (a manually saved draft) can mean "No liquidity filter" by its absence;
  // a compiler-written spec never carries the app's liquidity answer (D3),
  // so there absence means "not answered yet" and the current answer is kept.
  function populateFromSpec(spec: DraftSpec | null, { absentLiquidity }: { absentLiquidity: "none" | "keep" }): void {
    if (!spec) return;
    if (spec.structure) setStructure(spec.structure);

    const liquidityCond = spec.conditions.find(isLiquidityCondition);
    setConditions(spec.conditions.filter((c) => c !== liquidityCond));
    if (liquidityCond) {
      if (liquidityCond.value === 10) setLiquidity("confirm_10cr");
      else {
        setLiquidity("custom");
        setLiquidityCustom(String(liquidityCond.value));
      }
    } else if (absentLiquidity === "none") {
      setLiquidity("none");
    }
    // Every id already in the spec (including the liquidity condition's) is
    // spent: the next manual "Add condition", and the liquidity condition
    // buildSpec() appends, must never reuse one.
    const maxNo = spec.conditions.reduce((max, c) => {
      const m = /^C(\d+)$/.exec(c.id);
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0);
    nextConditionNo.current = Math.max(nextConditionNo.current, maxNo + 1);

    setHasSelectionPoint(spec.selection_point !== null && spec.selection_point !== undefined);
    setSessionOfWeek(spec.selection_point?.session_of_week !== undefined ? String(spec.selection_point.session_of_week) : "");
    setSelectionAt(spec.selection_point?.at ?? "");
    setStopFrom(spec.stop?.from ?? "");
    setHasRiskCap(spec.risk_cap_pct !== null && spec.risk_cap_pct !== undefined);
    setRiskCapPct(spec.risk_cap_pct !== null && spec.risk_cap_pct !== undefined ? String(spec.risk_cap_pct) : "");
    setHasNearMiss(spec.near_miss !== null && spec.near_miss !== undefined);
    setNearMissMaxFailed(spec.near_miss ? String(spec.near_miss.max_failed) : "");
    setHasT1Window(spec.t1_window !== null && spec.t1_window !== undefined);
    setT1LengthSessions(spec.t1_window?.length_sessions !== undefined ? String(spec.t1_window.length_sessions) : "");
    setT1OffsetsText((spec.t1_window?.offsets ?? []).join(", "));
  }

  function loadDraft(draft: LoadedDraft) {
    setDraftStatus(draft.status);
    setPromptText(draft.promptText ?? "");
    setHypothesis(draft.hypothesis ?? "");
    setKillCriterion(draft.killCriterion ?? "");
    // spec.structure is the freshest reading when a spec exists: a
    // null-structure re-compile leaves the column holding the previous
    // structure, but the spec (and its pending "structure" question) says
    // it's unresolved again.
    setStructure((draft.spec ? draft.spec.structure : draft.structure) ?? "");
    // A draft that was compiled and still carries its compiler state (pending
    // questions, unsupported items, source phrases) reopens with that state
    // visible — otherwise its pending questions would be unanswerable from
    // the UI short of re-running the model.
    const compiled = draft.needsInput != null || draft.sourcePhrases != null || draft.unsupported != null;
    if (compiled) {
      setCompileResult({
        structure: draft.spec?.structure ?? draft.structure ?? null,
        spec: draft.spec,
        needs_input: draft.needsInput ?? [],
        source_phrases: draft.sourcePhrases ?? [],
        unsupported: draft.unsupported ?? [],
      });
    }
    // sourcePhrases is cleared by any manual save that changes a traced value
    // (see the PATCH /api/drafts/:id route); while it is still set, the spec
    // is compiler-written and can't speak for the liquidity answer.
    populateFromSpec(draft.spec, { absentLiquidity: draft.sourcePhrases != null ? "keep" : "none" });
  }

  // The as_of sent to dry-run/confirm must be a real bar date: the engine's
  // grade_horizons matches the signal bar by exact date, so an arbitrary
  // "today" (any weekday, in the browser's clock) leaves every horizon
  // permanently "pending". Use the engine's own last_bar_date.
  async function resolveAsOf(): Promise<string> {
    try {
      const res = await fetch("/api/health");
      if (res.ok) {
        const health = await res.json();
        if (typeof health.last_bar_date === "string" && health.last_bar_date) return health.last_bar_date;
      }
    } catch {
      // fall through to the degraded fallback below
    }
    // Degraded fallback (accepted simplification): with the engine's health
    // unavailable, use today's date so the page stays usable. A non-bar-date
    // as_of may leave this run's horizons ungradable; the screen/confirm call
    // that follows will most likely fail anyway if the engine is truly down.
    return new Date().toISOString().slice(0, 10);
  }

  async function readMyPrompt() {
    if (!draftId) return;
    setCompiling(true);
    setCompileError(null);
    try {
      const saveRes = await fetch(`/api/drafts/${draftId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ promptText }),
      });
      if (!saveRes.ok) {
        setCompileError(describeApiError(await saveRes.json(), "could not save the prompt text"));
        return;
      }
      const res = await fetch(`/api/drafts/${draftId}/compile`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        setCompileError(describeApiError(body, "could not read this prompt"));
        return;
      }
      const spec: DraftSpec | null = body.spec ?? null;
      setCompileResult({
        structure: spec ? spec.structure : body.structure ?? null,
        spec,
        needs_input: body.needs_input ?? [],
        source_phrases: body.source_phrases ?? [],
        unsupported: body.unsupported ?? [],
      });
      // An unresolved structure clears the select rather than keeping a
      // stale choice: it is now a pending question.
      if (spec && spec.structure === null) setStructure("");
      populateFromSpec(spec, { absentLiquidity: "keep" });
    } finally {
      setCompiling(false);
    }
  }

  function onAnswered(path: string, spec: DraftSpec | null, needsInput: NeedsInput[] | null) {
    setCompileResult((prev) =>
      prev
        ? {
            ...prev,
            spec: spec ?? prev.spec,
            structure: spec?.structure ?? prev.structure,
            needs_input: needsInput ?? prev.needs_input.filter((x) => x.path !== path),
          }
        : prev
    );
    populateFromSpec(spec, { absentLiquidity: "keep" });
  }

  function phraseFor(path: string): string | null {
    return compileResult?.source_phrases.find((p) => p.path === path)?.phrase ?? null;
  }

  function addCondition() {
    const nextId = `C${nextConditionNo.current}`;
    nextConditionNo.current += 1;
    setConditions([...conditions, { id: nextId, role: "filter", kind: "field", name: "", params: {}, op: "", value: null }]);
  }

  function buildSpec(): DraftSpec | null {
    if (!structure) return null;
    const allConditions: Condition[] = [...conditions];
    if (liquidity === "confirm_10cr" || liquidity === "custom") {
      allConditions.push({
        id: `C${nextConditionNo.current}`, role: "filter", kind: "field", name: "traded_value_cr",
        params: { window: "1W" }, op: ">=", value: liquidity === "confirm_10cr" ? 10 : Number(liquidityCustom),
      });
    }
    // Partially-answered selection point / T1 window keep only the parts the
    // user (or the prompt) actually supplied — never a filled-in default.
    const selectionPoint: Partial<SelectionPoint> = {};
    if (sessionOfWeek.trim() !== "") selectionPoint.session_of_week = Number(sessionOfWeek);
    if (selectionAt) selectionPoint.at = selectionAt;
    const spec: DraftSpec = {
      spec_version: 4, structure, timeframe: "1W",
      selection_point: hasSelectionPoint ? selectionPoint : null,
      conditions: allConditions,
      stop: stopFrom.trim() ? { from: stopFrom.trim() } : null,
      risk_cap_pct: hasRiskCap && riskCapPct !== "" ? Number(riskCapPct) : null,
      near_miss: hasNearMiss && nearMissMaxFailed.trim() !== "" ? { max_failed: Number(nearMissMaxFailed) } : null,
    };
    // t1_window is only written when used, so a spec that never had one keeps
    // the exact shape (and spec_hash) it had before this field existed.
    if (hasT1Window) {
      const t1: Partial<T1Window> = {};
      if (t1LengthSessions.trim() !== "") t1.length_sessions = Number(t1LengthSessions);
      const offsets = parseOffsets(t1OffsetsText);
      if (offsets && offsets.length > 0) t1.offsets = offsets;
      spec.t1_window = t1;
    }
    return spec;
  }

  function gateReason(): string | null {
    if (!structure) return "Choose a structure";
    if (conditions.length === 0) return "Add at least one condition";
    if (compileResult && compileResult.needs_input.length > 0) return `Answer ${compileResult.needs_input.length} question(s) first`;
    if (compileResult && compileResult.unsupported.length > 0) return "Remove the unsupported condition(s) from your prompt first";
    if (hasSelectionPoint && (sessionOfWeek.trim() === "" || !selectionAt)) return "Complete the selection point (session and open/close)";
    if (hasNearMiss && !/^\d+$/.test(nearMissMaxFailed.trim())) return "Enter the near-miss max failed count";
    if (hasT1Window) {
      if (!/^\d+$/.test(t1LengthSessions.trim())) return "Enter the T1 window length in sessions";
      const offsets = parseOffsets(t1OffsetsText);
      if (offsets === null || offsets.length === 0) return "Enter the T1 window offsets (comma-separated whole numbers)";
    }
    if (liquidity === null) return "Answer the liquidity question";
    if (liquidity === "custom" && (liquidityCustom === "" || Number.isNaN(Number(liquidityCustom)))) {
      return "Enter a valid liquidity floor";
    }
    if (!hypothesis) return "Add a hypothesis";
    if (!killCriterion) return "Add a kill criterion";
    return null;
  }
  const blocked = gateReason();

  async function saveSpec(): Promise<SaveResult> {
    const spec = buildSpec();
    if (!draftId || !spec) return { ok: false, error: "Choose a structure and add a condition first" };
    let res: Response;
    try {
      res = await fetch(`/api/drafts/${draftId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ structure, specJson: JSON.stringify(spec), hypothesis, killCriterion }),
      });
    } catch (err) {
      return { ok: false, error: `Could not save the draft: ${(err as Error).message}` };
    }
    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // non-JSON error body — fall back to the generic message below
      }
      return { ok: false, error: `Could not save the draft: ${describeApiError(body, `save failed (${res.status})`)}` };
    }
    return { ok: true, spec };
  }

  async function dryRun() {
    setDryRunResult(null);
    const saved = await saveSpec();
    if (!saved.ok) return setDryRunResult(saved.error);
    const asOf = await resolveAsOf();
    const res = await fetch(`/api/drafts/${draftId}/dry-run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ as_of: asOf }),
    });
    const body = await res.json();
    if (!res.ok) {
      setDryRunResult(`Dry run failed: ${describeApiError(body, "dry run failed")}`);
      return;
    }
    const byMembership: Record<string, number> = {};
    for (const c of body.candidates ?? []) byMembership[c.membership] = (byMembership[c.membership] ?? 0) + 1;
    const total = body.candidates?.length ?? 0;
    setDryRunResult(
      `Dry run (not recorded in the forward test): ${total} candidate${total === 1 ? "" : "s"}` +
        (total > 0
          ? ` — ${byMembership.full_match ?? 0} full match, ${byMembership.near_miss ?? 0} near miss, ${byMembership.rejected_risk_cap ?? 0} rejected (risk cap)`
          : "")
    );
  }

  async function confirm() {
    const reason = gateReason();
    if (reason) return setBlockedReason(reason);
    setBlockedReason(null);
    setConfirming(true);
    try {
      // Never confirm on top of a save that didn't land: the server would
      // confirm whatever spec it last had, not what this form shows.
      const saved = await saveSpec();
      if (!saved.ok) {
        setBlockedReason(saved.error);
        return;
      }
      const asOf = await resolveAsOf();
      const res = await fetch(`/api/drafts/${draftId}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ as_of: asOf }),
      });
      const body = await res.json();
      if (!res.ok) {
        setBlockedReason(describeApiError(body, "confirm failed"));
        return;
      }
      // The prompt is confirmed even when post-confirm engine work (arm
      // registration, first selection, retiring a superseded parent's arm)
      // failed — tell the user before leaving the page.
      if (body.selection_warning) window.alert(body.selection_warning);
      router.push(`/watchlists/${body.watchlist_id}`);
    } finally {
      setConfirming(false);
    }
  }

  if (loadError) {
    return (
      <main>
        <h1>Draft {initialDraftId}</h1>
        <p role="alert">{loadError}</p>
      </main>
    );
  }

  return (
    <main>
      <h1>Draft {draftId ?? "…"} · not yet numbered</h1>
      {draftStatus && draftStatus !== "open" && <p role="status">This draft is {draftStatus}; it can no longer be confirmed.</p>}

      <label>
        Your prompt
        <textarea aria-label="prompt text" value={promptText} onChange={(e) => setPromptText(e.target.value)} />
      </label>
      <button type="button" onClick={readMyPrompt} disabled={compiling || !promptText.trim() || !draftId}>
        {compiling ? "Reading…" : "Read my prompt"}
      </button>
      {compileError && <p role="alert">{compileError}</p>}

      {compileResult && (
        <section>
          <p>
            {compileResult.spec?.conditions.length ?? 0} condition{(compileResult.spec?.conditions.length ?? 0) === 1 ? "" : "s"} found ·{" "}
            {compileResult.needs_input.length} question{compileResult.needs_input.length === 1 ? "" : "s"}
          </p>
          <p>
            Structure: <strong>{compileResult.structure ?? "unclear"}</strong>
            {phraseFor("structure") && <> — decided by &quot;{phraseFor("structure")}&quot;</>}
          </p>

          <h2>How your prompt was read</h2>
          <table>
            <thead><tr><th>Role</th><th>Condition</th><th>Parameters</th><th>Your words</th></tr></thead>
            <tbody>
              {(compileResult.spec?.conditions ?? []).map((c, i) => (
                <tr key={c.id}>
                  <td>{c.role}</td>
                  <td>{c.kind}:{c.name}</td>
                  <td>
                    {Object.keys(c.params ?? {}).length === 0 && !phraseFor(`conditions.${i}.params`) ? "—" : null}
                    {Object.entries(c.params ?? {}).map(([k, v]) => (
                      <span key={k}>{k}={String(v)} </span>
                    ))}
                    {/* A required param this condition is still missing shows as an amber "?", not silently as nothing */}
                    {compileResult.needs_input.filter((n) => n.path.startsWith(`conditions.${i}.params.`)).map((n) => (
                      <span key={n.path} style={{ color: "#b45f06" }} title={n.question}>?</span>
                    ))}
                  </td>
                  <td>{phraseFor(`conditions.${i}.params.${Object.keys(c.params ?? {})[0] ?? ""}`) ?? phraseFor(`conditions.${i}.value`) ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {compileResult.unsupported.length > 0 && (
            <div role="alert" style={{ border: "2px solid #c00", padding: "8px" }}>
              <strong>Unsupported conditions — remove these from your prompt and read it again:</strong>
              <ul>
                {compileResult.unsupported.map((u, i) => <li key={i}>&quot;{u.text}&quot; — {u.reason}</li>)}
              </ul>
            </div>
          )}

          {compileResult.needs_input.length > 0 && (
            <fieldset>
              <legend>Questions for you</legend>
              {compileResult.needs_input.map((n, i) => (
                <QuestionRow
                  key={n.path}
                  index={i + 1}
                  item={n}
                  draftId={draftId!}
                  onAnswered={(path, spec, needsInput) => onAnswered(path, spec as DraftSpec | null, needsInput)}
                />
              ))}
            </fieldset>
          )}
        </section>
      )}

      <label>
        Structure
        <select aria-label="structure" value={structure} onChange={(e) => setStructure(e.target.value as Structure | "")}>
          <option value="">— choose —</option>
          <option value="literal">literal</option>
          <option value="t1_literal">t1_literal</option>
        </select>
      </label>

      {conditions.map((c) => (
        <ConditionRow
          key={c.id}
          condition={c}
          onChange={(next) => setConditions(conditions.map((x) => (x.id === next.id ? next : x)))}
          onRemove={(id) => setConditions(conditions.filter((x) => x.id !== id))}
        />
      ))}
      <button type="button" onClick={addCondition}>Add condition</button>

      <fieldset>
        <legend>Selection point</legend>
        <label>
          <input type="checkbox" checked={hasSelectionPoint} onChange={(e) => setHasSelectionPoint(e.target.checked)} />
          Re-check at a selection point
        </label>
        {hasSelectionPoint && (
          <>
            <label>
              Session of week (1-5)
              <input
                aria-label="session of week" type="number" min={1} max={5}
                value={sessionOfWeek} onChange={(e) => setSessionOfWeek(e.target.value)}
              />
            </label>
            <label>
              At
              <select aria-label="selection at" value={selectionAt} onChange={(e) => setSelectionAt(e.target.value as "open" | "close" | "")}>
                <option value="">— choose —</option>
                <option value="open">open</option>
                <option value="close">close</option>
              </select>
            </label>
          </>
        )}
      </fieldset>

      <label>
        Stop — condition id it comes from (e.g. C3), leave blank for none
        <input aria-label="stop from" value={stopFrom} onChange={(e) => setStopFrom(e.target.value)} />
      </label>

      <fieldset>
        <legend>Risk cap</legend>
        <label>
          <input type="checkbox" checked={hasRiskCap} onChange={(e) => setHasRiskCap(e.target.checked)} />
          Reject candidates past a risk cap
        </label>
        {hasRiskCap && (
          <label>
            Risk cap % of entry
            <input aria-label="risk cap pct" type="number" value={riskCapPct} onChange={(e) => setRiskCapPct(e.target.value)} />
          </label>
        )}
      </fieldset>

      <fieldset>
        <legend>Near miss</legend>
        <label>
          <input type="checkbox" checked={hasNearMiss} onChange={(e) => setHasNearMiss(e.target.checked)} />
          Show near misses on the watchlist (never graded)
        </label>
        {hasNearMiss && (
          <label>
            Max failed conditions (0 = none)
            <input aria-label="near miss max failed" type="number" min={0} value={nearMissMaxFailed} onChange={(e) => setNearMissMaxFailed(e.target.value)} />
          </label>
        )}
      </fieldset>

      <fieldset>
        <legend>T1 window</legend>
        <label>
          <input type="checkbox" aria-label="use a T1 window" checked={hasT1Window} onChange={(e) => setHasT1Window(e.target.checked)} />
          Check over a rolling window of sessions (t1_literal)
        </label>
        {hasT1Window && (
          <>
            <label>
              Window length (sessions)
              <input aria-label="t1 window length sessions" type="number" min={1} value={t1LengthSessions} onChange={(e) => setT1LengthSessions(e.target.value)} />
            </label>
            <label>
              Offsets (comma-separated session offsets)
              <input aria-label="t1 window offsets" value={t1OffsetsText} onChange={(e) => setT1OffsetsText(e.target.value)} />
            </label>
          </>
        )}
      </fieldset>

      <fieldset>
        <legend>Liquidity</legend>
        <label>
          <input type="radio" name="liquidity" checked={liquidity === "confirm_10cr"} onChange={() => setLiquidity("confirm_10cr")} />
          Yes, ₹10 cr/week
        </label>
        <label>
          <input type="radio" name="liquidity" checked={liquidity === "custom"} onChange={() => setLiquidity("custom")} />
          Yes, my own floor{" "}
          <input aria-label="custom liquidity floor" value={liquidityCustom} onChange={(e) => setLiquidityCustom(e.target.value)} />
        </label>
        <label>
          <input type="radio" name="liquidity" checked={liquidity === "none"} onChange={() => setLiquidity("none")} />
          No liquidity filter
        </label>
      </fieldset>

      <label>
        Hypothesis
        <textarea aria-label="hypothesis" value={hypothesis} onChange={(e) => setHypothesis(e.target.value)} />
      </label>
      <label>
        Kill criterion
        <textarea aria-label="kill criterion" value={killCriterion} onChange={(e) => setKillCriterion(e.target.value)} />
      </label>

      <button type="button" onClick={dryRun}>Dry run</button>
      {dryRunResult && <p>{dryRunResult}</p>}

      <button type="button" onClick={confirm} disabled={!!blocked || confirming} title={blocked ?? undefined}>
        {confirming ? "Confirming…" : "Confirm and assign Prompt ID"}
      </button>
      {(blocked || blockedReason) && <p role="alert">{blockedReason ?? blocked}</p>}
    </main>
  );
}
