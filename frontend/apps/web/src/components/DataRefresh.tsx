"use client";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { describeApiError } from "@/lib/apiError";
import { ageOf, barInProgress, barLabel, whenLabel } from "@/lib/dataRefresh";
import { Button } from "@/ui/Button";
import styles from "./DataStatus.module.css";

type Status = {
  state: "idle" | "running" | "done" | "error"; done: number; total: number; error: string | null;
  last_refreshed: { fetched_at: string | null; latest_bar_date: string | null };
};
const KEY = ["data-refresh"];

async function load(): Promise<Status | null> {
  try { const r = await fetch("/api/data/refresh", { cache: "no-store" }); return r.ok ? await r.json() : null; } catch { return null; }
}
async function loadRole(): Promise<string | null> {
  try { const r = await fetch("/api/auth/me"); return r.ok ? ((await r.json()).currentUser?.role ?? null) : null; } catch { return null; }
}

// When the market data was last refreshed, and a way to refresh it. Anyone can see the time; only the owner can start
// a refresh (it pulls the whole universe from Yahoo, ~15 minutes, and reloads the engine). Never blocks a screen run.
export function DataRefresh({ onRefreshed, pollMs = 3000 }: { onRefreshed?: () => void; pollMs?: number }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: load, retry: false, refetchInterval: (query) => (query.state.data?.state === "running" ? pollMs : false) });
  const role = useQuery({ queryKey: ["me-role"], queryFn: loadRole, retry: false, staleTime: Infinity });
  const [message, setMessage] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const sawRunning = useRef(false);
  const s = q.data ?? null;

  useEffect(() => {
    if (!s) return;
    if (s.state === "running") sawRunning.current = true;
    if (s.state === "done" && sawRunning.current) {
      sawRunning.current = false;
      setMessage({ tone: "ok", text: "Data refreshed. Click Run again to screen on the new data." });
      onRefreshed?.();
    }
    if (s.state === "error" && sawRunning.current) { sawRunning.current = false; setMessage({ tone: "warn", text: s.error ?? "The refresh failed. The previous data was kept." }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s?.state]);

  if (!s) return null;   // engine unreachable: the engine pill already says so
  const running = s.state === "running";
  const now = Date.now();
  const age = ageOf(s.last_refreshed.fetched_at, now);
  const bar = s.last_refreshed.latest_bar_date;
  const pct = s.total ? Math.round((s.done / s.total) * 100) : null;

  async function start() {
    setStarting(true); setMessage(null);
    try {
      const res = await fetch("/api/data/refresh", { method: "POST" });
      const body = await res.json();
      if (!res.ok) { setMessage({ tone: "warn", text: res.status === 403 ? "Only the owner can refresh the data." : describeApiError(body, "could not start the refresh") }); return; }
      sawRunning.current = true;
      qc.setQueryData(KEY, { ...s, ...body });
    } catch { setMessage({ tone: "warn", text: "could not reach the server" }); } finally { setStarting(false); }
  }

  return (
    <div aria-label="data refresh" className={styles.refresh}>
      <span>
        Market data refreshed <strong>{whenLabel(s.last_refreshed.fetched_at)}</strong>
        {age && <span data-stale={age.stale} className={age.stale ? styles.staleAge : undefined}> ({age.label}{age.stale ? " — older than 12 h" : ""})</span>}
        {bar && <> · latest weekly bar: {barLabel(bar)}{barInProgress(bar, now) ? " (week in progress)" : ""}</>}
      </span>
      {role.data === "owner" ? (
        <Button size={36} onClick={() => void start()} disabled={running || starting}>{running ? "Refreshing…" : "Refresh data"}</Button>
      ) : role.data ? <span className={styles.note}>Only the owner can refresh.</span> : null}
      {running && (
        <span className={styles.note} role="status" aria-live="polite">
          Refreshing prices{s.total ? ` · ${s.done.toLocaleString()} of ${s.total.toLocaleString()}${pct !== null ? ` (${pct}%)` : ""}` : "…"} — you can keep working; the screen reloads its data when this finishes.
        </span>
      )}
      {message && <span role={message.tone === "warn" ? "alert" : "status"} className={message.tone === "warn" ? styles.err : styles.note}>{message.text}</span>}
    </div>
  );
}
