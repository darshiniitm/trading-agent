"use client";
import { useState } from "react";
import { describeApiError } from "@/lib/apiError";
import { Button } from "@/ui/Button";
import { Banner } from "@/ui/Banner";
import type { DataHealth } from "@/server/engine/client";

const when = (iso: string) => iso.replace("T", " ").slice(0, 16);

export function DataHealthView({ health }: { health: DataHealth }) {
  const [state, setState] = useState<{ kind: "idle" | "started" | "error"; message?: string }>({ kind: "idle" });
  async function prefetch() {
    setState({ kind: "idle" });
    try {
      const res = await fetch("/api/data/prefetch", { method: "POST" });
      const json = await res.json();
      setState(res.ok ? { kind: "started" } : { kind: "error", message: describeApiError(json, "could not start the prefetch") });
    } catch { setState({ kind: "error", message: "could not reach the server" }); }
  }
  return (
    <section aria-label="data health">
      <h1>Data health</h1>
      <p>{health.stale_symbols} stale symbols · {health.missing_symbols} missing symbols · {health.approximated_indices.length} approximated {health.approximated_indices.length === 1 ? "index" : "indices"}</p>
      <Button onClick={prefetch}>Run prefetch now</Button>
      {state.kind === "started" && <Banner role="status">Prefetch started. It runs in the background; reload in a minute to see the result.</Banner>}
      {state.kind === "error" && <Banner tone="warn" role="alert">{state.message}</Banner>}

      <h2>Last successful fetch</h2>
      {health.last_success.length === 0 ? <p>No successful fetch recorded yet.</p> : (
        <table aria-label="last successful fetch"><thead><tr><th>Provider</th><th>Data</th><th>Last OK</th></tr></thead>
          <tbody>{health.last_success.map((r) => <tr key={`${r.provider}${r.data_type}`}><td>{r.provider}</td><td>{r.data_type}</td><td>{when(r.last_ok_at)}</td></tr>)}</tbody></table>
      )}

      {health.approximated_indices.length > 0 && (
        <>
          <h2>Approximated indices</h2>
          <table aria-label="approximated indices"><thead><tr><th>Index</th><th>Rule</th><th>Last used</th></tr></thead>
            <tbody>{health.approximated_indices.map((r) => <tr key={r.index_name}><td>{r.index_name}</td><td>{r.rule}</td><td>{when(r.last_used_at)}</td></tr>)}</tbody></table>
        </>
      )}

      <h2>Which sources fail most</h2>
      {health.failures_by_provider.length === 0 ? <p>No failures recorded.</p> : (
        <table aria-label="failures by provider"><thead><tr><th>Provider</th><th>Data</th><th>Reason</th><th>Count</th></tr></thead>
          <tbody>{health.failures_by_provider.map((r) => <tr key={`${r.provider}${r.data_type}${r.reason}`}><td>{r.provider}</td><td>{r.data_type}</td><td>{r.reason}</td><td>{r.n}</td></tr>)}</tbody></table>
      )}

      <h2>Recent gaps</h2>
      {health.recent_gaps.length === 0 ? <p>No gaps logged.</p> : (
        <table aria-label="recent gaps"><thead><tr><th>When</th><th>Data</th><th>Symbol</th><th>Provider</th><th>Reason</th><th>Detail</th></tr></thead>
          <tbody>{health.recent_gaps.map((g) => <tr key={g.id}><td>{when(g.logged_at)}</td><td>{g.data_type}</td><td>{g.symbol ?? "—"}</td><td>{g.provider}</td><td>{g.reason}</td><td>{g.detail}</td></tr>)}</tbody></table>
      )}
    </section>
  );
}
