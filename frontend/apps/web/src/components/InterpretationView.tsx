"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { describeApiError } from "@/lib/apiError";
import { isWarmingBody } from "@/lib/engineStatus";
import { useEngineStatus } from "@/lib/useEngineStatus";
import { EngineBuffer, RunningPanel } from "@/components/EngineStatus";
import { DataRefresh } from "@/components/DataRefresh";
import { FeasibilityChip, RunHeader, UnevaluatedSection, UploadControl, reasonText } from "@/components/DataStatus";
import type { Feasibility } from "@/server/engine/client";
import { ruleLine, type Slot } from "@/lib/conditionLabel";
import { Button } from "@/ui/Button";
import { Card } from "@/ui/Card";
import { Banner } from "@/ui/Banner";
import { ProvenanceDot } from "@/ui/ProvenanceDot";
import styles from "./InterpretationView.module.css";

type Clause = { id: string; text: string; status: "ok" | "question" | "ignored" | "not_understood" | "model"; maps_to: string; questions: number };
type Chip = { path: string; label: string; value: unknown; provenance: "assumed" | "inferred" | "edited"; options?: { label: string; value: unknown }[] };
export type ProgramViewData = {
  clauses: Clause[]; chips: Chip[]; conditions: Slot[]; normalised: string; problems: string[]; ready: boolean;
  notEvaluable: { id: string; text: string; reason: string }[];
  addons: {
    liquidity: { enabled: boolean; cr: number | null; suggested_cr: number };
    min_price: { enabled: boolean; price: number | null };
    asm_gsm: { enabled: boolean; available: boolean; reason: string };
  };
};

const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

// Re-exported so existing imports keep working; the wording lives in lib/conditionLabel.
export { ruleLine };

const show = (c: Chip) => {
  const o = c.options?.find((x) => JSON.stringify(x.value) === JSON.stringify(c.value));
  return o ? o.label : Array.isArray(c.value) ? c.value.join(", ") : String(c.value);
};

// "How your prompt was read": every line of the user's prompt next to the rule it became. Anything the
// prompt left open was filled in automatically and shows as a chip you can click to change; a change
// re-runs the screen. Nothing here asks a question or blocks the run (docs/prompt-interpreter-spec.md).
const WARMING = Symbol("engine-warming");

export function InterpretationView({ draftId, promptText, hasProgram = false, onViewChange, onPromptTextChange, addonsExtra }: {
  draftId: number; promptText: string; hasProgram?: boolean; onViewChange?: (v: ProgramViewData | null) => void; onPromptTextChange?: (text: string) => void; addonsExtra?: ReactNode;
}) {
  const [view, setViewState] = useState<ProgramViewData | null>(null);
  const setView = (v: ProgramViewData | null) => { setViewState(v); onViewChange?.(v); };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [chipEdit, setChipEdit] = useState<{ path: string; text: string } | null>(null);
  const [floor, setFloor] = useState("");
  const [minPrice, setMinPrice] = useState("");
  const [asOf, setAsOf] = useState("");
  const [run, setRun] = useState<any | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [table, setTable] = useState<any | null>(null);          // the primary list: every stock, every condition's value
  const [tableState, setTableState] = useState<"idle" | "loading" | "failed">("idle");
  const runId = useRef(0);
  const [feas, setFeas] = useState<Feasibility | null>(null);  // data availability chips; null = still checking / unavailable

  // The engine loads ~2,300 stocks the first time. A run asked for meanwhile is queued — shown, cancellable, and started
  // the moment the engine is ready — instead of failing with an error.
  const eng = useEngineStatus();
  // Unknown state (not loaded yet, or the status call failed) never blocks a run: the engine's own 503 is handled below.
  const engineReady = !eng.status || eng.status.state === "ready";
  const waiters = useRef<((go: boolean) => void)[]>([]);
  const [queued, setQueued] = useState(false);
  const [screening, setScreening] = useState(false);   // the screen request itself is in flight (engine ready, results not back yet)
  useEffect(() => {
    if (!engineReady) return;
    const w = waiters.current.splice(0);
    w.forEach((go) => go(true));
  }, [engineReady]);
  useEffect(() => () => { waiters.current.splice(0).forEach((go) => go(false)); }, []);   // leaving the page cancels a queued run
  const readyNow = useRef(false);
  readyNow.current = engineReady;
  /** Resolves true when the engine is ready, false if the run was cancelled meanwhile. */
  function whenEngineReady(): Promise<boolean> {
    if (readyNow.current) return Promise.resolve(true);
    setQueued(true);
    return new Promise<boolean>((resolve) => { waiters.current.push(resolve); }).finally(() => setQueued(false));
  }
  function cancelQueued() { runId.current++; setScreening(false); waiters.current.splice(0).forEach((go) => go(false)); }

  // Reopening a draft (or a copied/edited prompt) that already has a program shows it straight away.
  useEffect(() => {
    if (!hasProgram) return;
    fetch(`/api/drafts/${draftId}/program`).then(async (r) => { if (r.ok) { const v = await r.json(); setView(v); void screenNow(v); } }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId, hasProgram]);

  async function post(url: string, body?: unknown): Promise<any | null> {
    setBusy(true); setError(null);
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      const json = await res.json();
      if (res.status === 503 && isWarmingBody(json)) return WARMING;   // the engine is (still) loading: not an error, the caller queues
      if (!res.ok) { setError(describeApiError(json, "something went wrong")); return null; }
      return json;
    } finally { setBusy(false); }
  }

  async function latestAsOf(): Promise<string> {
    if (asOf) return asOf;
    let d = new Date().toISOString().slice(0, 10);
    try {
      const h = await fetch("/api/health");
      if (h.ok) { const j = await h.json(); if (typeof j.last_bar_date === "string" && j.last_bar_date) d = j.last_bar_date; }
    } catch { /* degrade to today */ }
    setAsOf(d);
    return d;
  }

  // The screen runs as soon as the prompt is read, and again after every change — never behind a question.
  async function screenNow(v: ProgramViewData | null = view, date?: string) {
    if (v && !v.ready) { setRun(null); return; }
    setRunError(null);
    const mine = ++runId.current;
    if (!(await whenEngineReady()) || mine !== runId.current) return;   // queued while the engine loads; cancelled or superseded -> stop
    const as_of = date ?? await latestAsOf();   // after the wait: while loading, the engine cannot say which week has data
    setTable(null); setTableState("idle");
    void loadFeasibility(as_of);                  // never awaited: the chips fill in, the run is not held up
    setScreening(true);
    let r = await post(`/api/drafts/${draftId}/program/screen`, { as_of }).finally(() => { if (mine === runId.current) setScreening(false); });
    // the engine answered "still loading" although the last status said ready (it restarted): queue again, a few times at most
    for (let again = 0; r === WARMING && again < 3; again++) {
      setScreening(false);
      await eng.refetch();
      await new Promise((go) => setTimeout(go, 1500));              // status may still say ready for a moment: don't spin
      if (!(await whenEngineReady()) || mine !== runId.current) return;
      setScreening(true);
      r = await post(`/api/drafts/${draftId}/program/screen`, { as_of }).finally(() => { if (mine === runId.current) setScreening(false); });
    }
    if (r === WARMING) { setRunError("The data engine is still starting. Try Run again in a moment; the rules above are saved."); return; }
    if (!r) { setRunError("The screen could not run just now; the rules above are saved."); return; }
    setRun(r);
    void loadTable(as_of, mine);
  }

  // Non-blocking data check (spec §6.2): if it fails or is slow the chips simply do not appear.
  async function loadFeasibility(as_of: string) {
    setFeas(null);
    try {
      const res = await fetch(`/api/drafts/${draftId}/program/feasibility`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ as_of }) });
      const json = await res.json();
      if (res.ok && json.feasibility) setFeas(json.feasibility);
    } catch { /* chips stay hidden */ }
  }

  // The full list covers every stock in the universe, so it is slower than the screen itself: the result above
  // shows first and the list fills in behind it. A newer run discards an older run's list.
  async function loadTable(as_of: string, mine: number) {
    setTableState("loading");
    try {
      const res = await fetch(`/api/drafts/${draftId}/program/screen`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ as_of, table: true }) });
      const json = await res.json();
      if (mine !== runId.current) return;
      if (!res.ok || !json.table) { setTableState("failed"); return; }
      setTable(json.table); setTableState("idle");
    } catch { if (mine === runId.current) setTableState("failed"); }
  }

  async function interpret() {
    setBusy(true); setError(null); setRun(null);
    try {
      const save = await fetch(`/api/drafts/${draftId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ promptText }) });
      if (!save.ok) { setError(describeApiError(await save.json(), "could not save the prompt text")); return; }
    } finally { setBusy(false); }
    const v = await post(`/api/drafts/${draftId}/program`);
    if (v) { setView(v); await screenNow(v); }
  }

  async function change(body: unknown, after?: () => void) {
    const v = await post(`/api/drafts/${draftId}/program/answer`, body);
    if (v) { setView(v); after?.(); await screenNow(v); }
  }
  const saveChip = (c: Chip) => {
    const t = (chipEdit?.text ?? "").trim();
    return change({ path: c.path, value: DECIMAL.test(t) ? Number(t) : t }, () => setChipEdit(null));
  };
  const pickChip = (c: Chip, idx: number) => change({ path: c.path, value: c.options![idx].value }, () => setChipEdit(null));
  // The server rewrites the draft's text for a line edit: pull it back so the textarea never holds a stale copy
  // ("Read my prompt and run it" would otherwise save the stale text over the edit).
  const syncPromptText = async () => {
    try { const r = await fetch(`/api/drafts/${draftId}`); if (r.ok) { const d = await r.json(); if (typeof d.promptText === "string") onPromptTextChange?.(d.promptText); } } catch { /* the textarea keeps its text */ }
  };
  const saveEdit = () => editing && change({ edit: { clause_id: editing.id, text: editing.text } }, () => { setEditing(null); setChipEdit(null); void syncPromptText(); });

  const chipsFor = (c: Clause) => {
    const ids = [...c.maps_to.matchAll(/\b([CA]\d+)\b/g)].map((m) => m[1]);
    return (view?.chips ?? []).filter((k) => ids.some((id) => k.path.startsWith(`conditions.${id}.`) || k.path.startsWith(`actions.${id}.`)) || (/universe/.test(c.maps_to) && k.path.startsWith("universe.")));
  };
  const shownChips = new Set(view ? view.clauses.flatMap((c) => chipsFor(c).map((k) => k.path)) : []);
  const strays = (view?.chips ?? []).filter((k) => !shownChips.has(k.path));

  // A plain render function, not a component: a component defined inside this one is a new type on every render,
  // so React remounted it per keystroke and the text box lost focus after one character.
  function chipButton(c: Chip) {
    const open = chipEdit?.path === c.path;
    return (
      <span key={c.path} data-chip={c.path} data-provenance={c.provenance} className={styles.chipWrap}>
        <button type="button" className={styles.chip} aria-label={`change ${c.label}`} disabled={busy} onClick={() => setChipEdit(open ? null : { path: c.path, text: c.options || Array.isArray(c.value) ? "" : String(c.value ?? "") })}>
          <ProvenanceDot origin={c.provenance} />
          {c.label}: {show(c)} · {c.provenance === "edited" ? "edited by you" : c.provenance}
        </button>
        {open && (c.options ? (
          <select className={styles.inline} aria-label={`new value for ${c.label}`} value="" onChange={(e) => { if (e.target.value !== "") void pickChip(c, Number(e.target.value)); }}>
            <option value="">— change to —</option>
            {c.options.map((o, i) => <option key={i} value={i}>{o.label}</option>)}
          </select>
        ) : (
          <>
            <input className={styles.inline} aria-label={`new value for ${c.label}`} value={chipEdit!.text} onChange={(e) => setChipEdit({ path: c.path, text: e.target.value })} />
            <Button size={36} disabled={busy || !chipEdit!.text.trim() || (typeof c.value === "number" && !DECIMAL.test(chipEdit!.text.trim()))} onClick={() => void saveChip(c)}>Apply</Button>
            {typeof c.value === "number" && chipEdit!.text.trim() !== "" && !DECIMAL.test(chipEdit!.text.trim()) && <span role="alert" className={styles.refresh}>Enter a number</span>}
          </>
        ))}
      </span>
    );
  }

  const slotsOf = (c: Clause) => (view?.conditions ?? []).filter((s) => s.evaluable && new RegExp(`(^|; )${s.id}:`).test(c.maps_to));
  const ad = view?.addons;

  return (
    <section aria-label="how your prompt was read" className={styles.cols}>
      <div className={styles.left}>
      <Button variant="primary" size={44} onClick={interpret} disabled={busy || !promptText.trim()}>{busy && !view ? "Reading…" : "Read my prompt and run it"}</Button>
      {error && <Banner tone="warn" role="alert">{error}</Banner>}

      {view && (
        <>
          <Card title="How your prompt was read">
          <table className={styles.reading}>
            <tbody>
              {view.clauses.map((c) => {
                const grey = c.status === "not_understood" || c.status === "ignored";
                return (
                  <tr key={c.id} data-status={c.status} style={grey ? { opacity: 0.55 } : undefined}>
                    <td>
                      {editing?.id === c.id ? (
                        <>
                          <input className={styles.inline} aria-label={`edit line ${c.id}`} value={editing.text} onChange={(e) => setEditing({ id: c.id, text: e.target.value })} />
                          <Button size={36} variant="primary" onClick={saveEdit} disabled={busy || !editing.text.trim()}>Save line</Button>
                          <Button size={36} onClick={() => setEditing(null)}>Cancel</Button>
                        </>
                      ) : <>“{c.text}”</>}
                    </td>
                    <td>
                      {c.status === "not_understood" ? <span>Not used: {c.maps_to}</span>
                        : slotsOf(c).length > 0 ? slotsOf(c).map((s) => <div key={s.id}>{ruleLine(s)}</div>)
                        : c.maps_to}
                      <div className={styles.chips}>{chipsFor(c).map((k) => chipButton(k))}</div>
                      {feas && <div>{[...c.maps_to.matchAll(/\b(C\d+)\b/g)].map((m) => m[1]).filter((id, i, a) => a.indexOf(id) === i && feas.conditions[id])
                        .map((id) => <FeasibilityChip key={id} entry={feas.conditions[id]} />)}</div>}
                    </td>
                    <td>{editing?.id !== c.id && <Button size={36} onClick={() => setEditing({ id: c.id, text: c.text })}>Edit</Button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </Card>
          {strays.length > 0 && <div aria-label="other assumptions" className={styles.chips}>{strays.map((k) => chipButton(k))}</div>}

          {view.notEvaluable.length > 0 && (
            <ul aria-label="not used" style={{ opacity: 0.55 }}>
              {view.notEvaluable.map((n, i) => <li key={`${n.id}-${i}`}>“{n.text}” — not used: {n.reason}</li>)}
            </ul>
          )}
          {!view.ready && <Banner tone="warn" role="alert">{view.problems.join("; ")}</Banner>}

          <details className={styles.addons}>
            <summary>Optional add-ons</summary>
            <p>All off. An add-on changes the results only when you switch it on.</p>
            <fieldset>
              <legend>Suggested filters</legend>
              <label>
                <input type="checkbox" checked={!!ad?.liquidity.enabled} disabled={busy}
                  onChange={(e) => change({ liquidity: e.target.checked ? { mode: "floor", cr: Number(floor) > 0 ? Number(floor) : ad!.liquidity.suggested_cr } : { mode: "none" } })} />
                Liquidity floor (₹ cr/week, median traded value) — {ad?.liquidity.enabled ? `${ad.liquidity.cr} cr` : `suggested ${ad?.liquidity.suggested_cr ?? 10} cr`}
              </label>{" "}
              <input className={styles.inline} aria-label="custom liquidity floor" value={floor} onChange={(e) => setFloor(e.target.value)} placeholder={String(ad?.liquidity.suggested_cr ?? 10)} />
              <Button size={36} disabled={busy || !DECIMAL.test(floor.trim()) || Number(floor) <= 0} onClick={() => change({ liquidity: { mode: "floor", cr: Number(floor.trim()) } })}>Use this floor</Button>
              <br />
              <label>
                <input type="checkbox" checked={!!ad?.min_price.enabled} disabled={busy || (!ad?.min_price.enabled && !(Number(minPrice) > 0))}
                  onChange={(e) => change({ min_price: e.target.checked ? { mode: "floor", price: Number(minPrice) } : { mode: "none" } })} />
                Minimum price (₹){ad?.min_price.enabled ? ` — ${ad.min_price.price}` : ""}
              </label>{" "}
              <input className={styles.inline} aria-label="minimum price" value={minPrice} onChange={(e) => setMinPrice(e.target.value)} />
              <br />
              <label>
                <input type="checkbox" checked={false} disabled />
                Exclude stocks on the ASM/GSM lists — unavailable: {ad?.asm_gsm.reason}
              </label>
            </fieldset>
            {addonsExtra}
          </details>
        </>
      )}
      </div>

      {view && (
        <div className={styles.right}>
          <div className={styles.runRow}>
            <label>Run on week of <input aria-label="as of date" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
            <Button onClick={() => screenNow(view, asOf)} disabled={busy || !asOf} disabledReason={!view.ready ? "no line was read as a rule yet" : null}>Run again</Button>
          </div>
          {eng.status && eng.status.state !== "ready" && !run && (
            <EngineBuffer status={eng.status} queued={queued} onCancel={cancelQueued} onRetry={eng.retry} retrying={eng.retrying} />
          )}
          {screening && !queued && !run && eng.status?.state !== "warming" && eng.status?.state !== "starting" && <RunningPanel firstRun />}
          {screening && !queued && run && <p className={styles.refresh} role="status" aria-live="polite">Updating results…</p>}
          {runError && !queued && <Banner tone="warn" role="alert">{runError}</Banner>}
          {!view.ready && <Banner role="status">Nothing to run yet: no line was read as a rule. Edit the line on the left (or reword the prompt) and it will run again.</Banner>}
          {feas && view.ready && (
            <div aria-label="universe data status" className={styles.universe}>
              Universe: <FeasibilityChip entry={feas.universe} />{" "}
              {feas.universe.can_upload && <UploadControl draftId={draftId} onUploaded={() => void screenNow(view, asOf)} />}
            </div>
          )}
          {view.ready && <DataRefresh />}
          {run && <RunHeader coverage={run.run_coverage} conditionLabels={Object.fromEntries(view.conditions.map((c) => [c.id, ruleLine(c)]))} />}
          {run && <AllStocks table={table} state={tableState} conditions={view.conditions} setLabels={Object.fromEntries(Object.entries(run.sets ?? {}).map(([k, v]: [string, any]) => [k, v.label ?? k]))} />}
          {run && <DryRunResult run={run} conditions={view.conditions} />}
        </div>
      )}
    </section>
  );
}

const fmt = (n: unknown, d = 2) => (typeof n === "number" ? n.toFixed(d) : "—");
const pct = (n: unknown) => (typeof n === "number" ? `${n.toFixed(2)}%` : "—");

// The dry run's answer: which stocks are in each set, then what each action produced.
function DryRunResult({ run, conditions }: { run: any; conditions: Slot[] }) {
  const sets = Object.entries(run.sets ?? {}) as [string, any][];
  const actions = Object.entries(run.actions ?? {}) as [string, any][];
  return (
    <div aria-label="dry run result">
      <h3>Result for week of {run.as_of}</h3>
      <p>{run.universe.count} stocks in the universe · {run.funnel.map((f: any) => `${f.label ?? f.stage}: ${f.count}`).join(" → ")}</p>
      {sets.map(([id, s]) => (
        <div key={id}>
          <h4>{id}{s.label ? ` — ${s.label}` : ""} ({s.count} stock{s.count === 1 ? "" : "s"})</h4>
          {s.count === 0 ? <p>No stocks matched this week.</p> : <SetTable id={id} set={s} sets={run.sets} conditions={conditions} />}
          <UnevaluatedSection rows={s.unevaluated ?? []} />
        </div>
      ))}
      {actions.map(([id, a]) => (
        <div key={id}>
          <h4>{id} — {a.type.replace("_", " ")}{a.set ? ` on ${a.set}` : ""}</h4>
          {a.type === "trade_plan" && (a.plans.length === 0 ? <p>No trade plans (no stocks in the set).</p> : (
            <table><thead><tr><th>Ticker</th><th>EP</th><th>SL</th><th>Risk</th><th>Confidence</th><th>Status</th></tr></thead>
              <tbody>{a.plans.map((p: any) => (
                <tr key={p.ticker}><td>{p.ticker}</td><td>{fmt(p.ep)}</td><td>{fmt(p.sl)}</td><td>{pct(p.r_pct)}</td><td>{p.confidence ? fmt(p.confidence.score, 1) : "—"}</td><td>{p.status}</td></tr>
              ))}</tbody></table>
          ))}
          {a.type === "group_by" && (<>
            <table><thead><tr><th>Sector</th><th>Stocks</th><th>Tickers</th></tr></thead>
              <tbody>{a.groups.map((g: any) => <tr key={g.sector}><td>{g.sector}</td><td>{g.count}</td><td>{g.tickers.join(", ")}</td></tr>)}</tbody></table>
            {a.highlight?.status === "ok" && <p>Outperforming: {(a.highlight.sectors ?? []).filter((x: any) => x.outperforming || x.rs_rank <= (a.highlight.rule?.top_k ?? 0) && x.outperforming !== false).map((x: any) => x.sector).join(", ") || "none"}</p>}
            {a.highlight && a.highlight.status !== "ok" && <p>Outperformance not computed: {a.highlight.status.replace(/_/g, " ")}.</p>}
          </>)}
          {a.type === "validate" && Object.entries(a.horizons).map(([h, v]: [string, any]) => (
            <div key={h}>
              <p>These are the stocks the same strategy selected one week earlier (week of {a.as_of_used}) — not this week's picks — and how they did over the following {h} week{h === "1" ? "" : "s"}: {v.n_graded} of {v.n_plans} graded · mean {pct(v.mean_return_pct)} · hit rate {v.hit_rate_pct ?? "—"}%</p>
              {v.rows.length > 0 && <table><thead><tr><th>Ticker</th><th>EP</th><th>Return</th></tr></thead>
                <tbody>{v.rows.map((r: any) => <tr key={r.ticker}><td>{r.ticker}</td><td>{fmt(r.ep)}</td><td>{typeof r.return === "number" ? pct(r.return * 100) : r.status}</td></tr>)}</tbody></table>}
            </div>
          ))}
          {(a.type === "rank" || a.type === "limit") && (
            <table><tbody>{a.rows.map((r: any) => <tr key={r.ticker}><td>{r.ticker}</td><td>{r.name}</td><td>{Object.entries(r).filter(([k]) => k.includes(".")).map(([k, v]) => `${k}: ${v}`).join(" ")}</td></tr>)}</tbody></table>
          )}
        </div>
      ))}
    </div>
  );
}

// Every stock in a set with each condition that put it there: the rule, the stock's actual value, and whether
// it passed. A set's conditions include those of the set it was drawn from (a stock in S2 passed S1's first).
const num = (n: number) => (Math.abs(n) >= 1000 ? n.toLocaleString("en-IN", { maximumFractionDigits: 0 }) : String(Math.round(n * 100) / 100));
const cellValue = (r: any): string => {
  if (!r) return "—";
  if (typeof r.value === "number") return num(r.value);
  if (typeof r.value === "string") return r.value;
  // an event rule (flip / cross): when it fired, which way, and where the stop line sits
  const parts = [r.direction, r.event_date, typeof r.stop_line === "number" ? `stop ${num(r.stop_line)}` : null].filter(Boolean);
  return parts.join(" · ") || "—";
};

// Hover: where a stock's price data came from and how old it is; why a condition is unknown or carries a warning.
const dataTitle = (d: any): string | undefined => d ? [`source: ${d.source}`, d.as_of ? `as of ${d.as_of}` : null, d.quality && d.quality !== "ok" ? d.quality : null].filter(Boolean).join(" · ") : undefined;
const cellTitle = (x: any): string | undefined => {
  if (!x) return undefined;
  const bits = [x.state === "?" && x.reason ? reasonText(x.reason) : null, ...(x.warnings ?? []).map(reasonText), x.input_quality ? `inputs: ${x.input_quality}` : null].filter(Boolean);
  return bits.length ? bits.join(" · ") : undefined;
};

function SetTable({ id, set, sets, conditions }: { id: string; set: any; sets: Record<string, any>; conditions: Slot[] }) {
  // walk up the `from` chain, nearest ancestor last, so columns read base → narrowest
  const chain: any[] = [];
  for (let cur: any = set; cur; cur = sets[cur.from]) chain.unshift(cur);
  const cols = chain.flatMap((st) => (st.members[0] ? Object.keys(st.members[0].conditions ?? {}) : []).map((cid) => ({ cid, from: st })));
  const byTicker = (st: any) => new Map<string, any>(st.members.map((m: any) => [m.ticker, m]));
  const lookups = new Map<any, Map<string, any>>(chain.map((st) => [st, byTicker(st)]));
  const slot = (cid: string) => conditions.find((c) => c.id === cid);
  return (
    <table aria-label={`${id} stocks`}>
      <thead>
        <tr><th>Ticker</th><th>Name</th><th>Sector</th>{cols.map((c) => <th key={c.cid} data-condition={c.cid}>{c.cid}: {slot(c.cid) ? ruleLine(slot(c.cid)!) : "condition"}</th>)}</tr>
      </thead>
      <tbody>
        {set.members.map((m: any) => (
          <tr key={m.ticker}>
            <td>{m.ticker}</td><td>{m.name}</td><td>{m.sector}</td>
            {cols.map((c) => {
              const r = lookups.get(c.from)?.get(m.ticker)?.conditions?.[c.cid];
              return (
                <td key={c.cid} data-condition={c.cid} data-passed={String(r?.passed ?? "")}>
                  {cellValue(r)} {r?.passed === true ? "✓" : r?.passed === false ? "✗" : ""}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// The primary list: every stock in the universe with each condition's actual value and pass/fail. Stocks that
// ended up selected are highlighted (selected first); the rest stay visible so you can see how close they came.
const SHOW_FIRST = 300;
function AllStocks({ table, state, conditions, setLabels }: { table: any | null; state: "idle" | "loading" | "failed"; conditions: Slot[]; setLabels: Record<string, string> }) {
  const [onlySelected, setOnlySelected] = useState(false);
  const [showAll, setShowAll] = useState(false);
  if (!table) {
    return state === "loading" ? <p role="status">Loading every stock with its values…</p>
      : state === "failed" ? <p role="alert">Could not load the full list of stocks just now.</p> : null;
  }
  const cids: string[] = table.conditions;
  const slot = (cid: string) => conditions.find((c) => c.id === cid);
  const passes = (r: any) => cids.filter((c) => r.conditions[c]?.passed === true).length;
  // "selected" = in the program's last set, i.e. every condition satisfied; being in an earlier set only means
  // passing the first filters, shown with a lighter highlight.
  const ids = Object.keys(setLabels);
  const last = ids[ids.length - 1];
  const isFinal = (r: any) => r.selected.includes(last);
  const rows = [...table.rows].sort((a: any, b: any) => Number(isFinal(b)) - Number(isFinal(a)) || b.selected.length - a.selected.length || passes(b) - passes(a) || a.ticker.localeCompare(b.ticker));
  const selected = rows.filter(isFinal).length;
  const partial = rows.filter((r: any) => r.selected.length > 0 && !isFinal(r)).length;
  const shown = (onlySelected ? rows.filter(isFinal) : rows).slice(0, showAll ? undefined : SHOW_FIRST);
  const total = onlySelected ? selected : rows.length;
  return (
    <div aria-label="all stocks">
      <h3>All stocks ({rows.length}) · {selected} selected{partial > 0 ? ` · ${partial} more pass only the earlier filters` : ""}</h3>
      <label><input type="checkbox" checked={onlySelected} onChange={(e) => setOnlySelected(e.target.checked)} /> Only selected</label>
      <table aria-label="all stocks table">
        <thead>
          <tr>
            <th>Ticker</th><th>Name</th><th>Sector</th>
            {cids.map((c) => <th key={c} data-condition={c}>{c}: {slot(c) ? ruleLine(slot(c)!) : "condition"}</th>)}
            <th>Met · unknown</th><th>Selected in</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r: any) => (
            <tr key={r.ticker} data-selected={String(isFinal(r))} data-partial={String(r.selected.length > 0 && !isFinal(r))}
                style={isFinal(r) ? { background: "rgba(46, 160, 67, 0.28)", fontWeight: 600 } : r.selected.length > 0 ? { background: "rgba(46, 160, 67, 0.07)" } : undefined}>
              <td title={dataTitle(r.data)}>{r.ticker}</td><td>{r.name}</td><td>{r.sector}</td>
              {cids.map((c) => {
                const x = r.conditions[c];
                return (
                  <td key={c} data-condition={c} data-passed={String(x?.passed ?? "")} data-state={String(x?.state ?? "")}
                      title={cellTitle(x)} style={x?.passed === false ? { opacity: 0.6 } : undefined}>
                    {cellValue(x)} {x?.passed === true ? "✓" : x?.passed === false ? "✗" : x?.state === "?" ? "?" : ""}
                  </td>
                );
              })}
              <td>{typeof r.met_count === "number" ? `${r.met_count} met · ${r.unknown_count ?? 0} unknown` : ""}</td>
              <td title={r.selected.map((id: string) => setLabels[id] ?? id).join(", ")}>{r.selected.join(", ") || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {total > shown.length && <button type="button" onClick={() => setShowAll(true)}>Show all {total} stocks</button>}
    </div>
  );
}
