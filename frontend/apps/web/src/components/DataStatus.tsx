"use client";
import { useState } from "react";
import { describeApiError } from "@/lib/apiError";
import styles from "./DataStatus.module.css";
import type { FeasibilityStatus, RunCoverage, UnevaluatedRow } from "@/server/engine/client";

// Data availability, shown — never asked about (docs/data-fallback-spec.md §6.2, §10.2). Missing data is a normal,
// visible state: nothing here blocks the run.

type Entry = { status: FeasibilityStatus; source?: string | null; as_of?: string | null; detail?: string | null };

export function chipText(e: Entry): string {
  switch (e.status) {
    case "ready": return "data ready";
    case "fallback": return e.source ? `via fallback · ${e.source}` : "via fallback";
    case "stale": return e.as_of ? `stale · as of ${e.as_of}` : "stale";
    case "approx": return e.detail ? `approx universe · ${e.detail}` : "approx universe";
    case "unavailable": return "no data source";
    default: return "checking…";
  }
}

// Source and as-of date on hover (§10.2).
const hover = (e: Entry) => [e.source ? `source: ${e.source}` : null, e.as_of ? `as of ${e.as_of}` : null, e.detail].filter(Boolean).join(" · ") || undefined;

export function FeasibilityChip({ entry }: { entry: Entry | null | undefined }) {
  const e = entry ?? { status: "unknown" as const };
  return <span data-feasibility={e.status} className={styles.chip} title={hover(e)} style={e.status === "ready" ? { opacity: 0.7 } : undefined}>{chipText(e)}</span>;
}

const REASON: Record<string, string> = {
  no_data: "no data from any source",
  insufficient_history: "not enough price history yet (e.g. a recent listing)",
  stale_data: "input data is out of date",
  approx_input: "evaluated on an approximated universe",
  partial_fields: "the data source lacks a field this rule needs (e.g. high/low)",
  unadjusted_prices: "prices may not be adjusted for a split or bonus",
  survivorship_risk: "historical run on today's constituent list",
  price_mismatch: "sources disagreed on the price",
  condition_unfeedable: "not applied: no data source",
};
export const reasonText = (code: string) => REASON[code] ?? code;

const STATUS_WORD = { complete: "complete", partial: "partial", low_coverage: "low coverage" } as const;

export function RunHeader({ coverage, conditionLabels }: { coverage: RunCoverage | undefined; conditionLabels: Record<string, string> }) {
  if (!coverage) return null;
  const pct = Math.round(coverage.coverage * 100);
  return (
    <div aria-label="run data status" className={styles.run}>
      <span data-run-status={coverage.status} className={styles.status}>{STATUS_WORD[coverage.status]}</span>{" "}
      <span>{pct}% of {coverage.universe_size} stocks fully evaluated</span> · <span>universe: {coverage.universe_quality}</span>
      {coverage.status === "low_coverage" && (
        <p role="alert" className={styles.alert}>Low coverage: less than 70% of the universe could be fully evaluated, so read these results with care. The run still completed.</p>
      )}
      {coverage.unfeedable_conditions.length > 0 && (
        <ul aria-label="conditions not applied">
          {coverage.unfeedable_conditions.map((id) => <li key={id}>{conditionLabels[id] ?? id} — not applied: no data source</li>)}
        </ul>
      )}
      {!coverage.scored && <p>This run is shown but not counted in forward-test scoring.</p>}
    </div>
  );
}

// Stocks the engine could not decide. They are never dropped silently (§5.3).
export function UnevaluatedSection({ rows }: { rows: UnevaluatedRow[] }) {
  if (!rows.length) return null;
  return (
    <div aria-label="unevaluated stocks" className={styles.uneval}>
      <h4>Unevaluated ({rows.length})</h4>
      <p>No known condition failed, but at least one could not be checked.</p>
      <table>
        <thead><tr><th>Ticker</th><th>Name</th><th>Why</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.set ?? ""}${r.ticker}`}>
              <td>{r.ticker}</td><td>{r.name}</td>
              <td>{r.reasons.map((x) => <div key={x}>{reasonText(x)}</div>)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const readText = (f: File): Promise<string> =>
  typeof f.text === "function" ? f.text() : new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => no(r.error); r.readAsText(f); });

// The optional escape hatch (§9.4): offered next to an approx / unavailable chip, never required.
export function UploadControl({ draftId, onUploaded }: { draftId: number; onUploaded: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function pick(file: File | undefined) {
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/drafts/${draftId}/program/upload`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: file.name, text: await readText(file) }),
      });
      const json = await res.json();
      if (!res.ok) { setError(describeApiError(json, "could not use that file")); return; }
      onUploaded();
    } catch { setError("could not read or send that file"); } finally { setBusy(false); }
  }
  return (
    <span>
      <label>Upload a universe CSV (a symbol column) <input aria-label="upload a universe csv" type="file" accept=".csv,text/csv" disabled={busy} onChange={(e) => void pick(e.target.files?.[0])} /></label>
      {error && <span role="alert" className={styles.err}> {error}</span>}
    </span>
  );
}
