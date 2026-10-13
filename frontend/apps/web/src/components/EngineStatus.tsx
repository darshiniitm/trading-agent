"use client";
import { useEffect, useState } from "react";
import { PHASE_LABEL, emptyStatus, formatElapsed, percent, statusLine, type EngineStatus } from "@/lib/engineStatus";
import { Button } from "@/ui/Button";
import { useEngineStatus } from "@/lib/useEngineStatus";
import styles from "./EngineStatus.module.css";

// The engine's state, shown rather than hidden (the first start loads ~2,300 stocks and takes minutes). Two pieces:
//   EnginePill    always in the header; a quiet dot when ready, so it only draws the eye when something is going on
//   EngineBuffer  the loading panel where results will appear: where it is, what's queued, and a way out

const dot = (s: EngineStatus["state"]) => (s === "ready" ? styles.ok : s === "error" ? styles.bad : s === "stopped" ? styles.idle : styles.busy);

export function EnginePill() {
  const { status, retry } = useEngineStatus();
  if (!status) return null;
  const s = status;
  return (
    <span className={styles.pill} data-engine-state={s.state} role="status" aria-live="polite">
      <span className={`${styles.dot} ${dot(s.state)}`} aria-hidden="true" />
      <span className={s.state === "ready" ? styles.quietText : undefined}>{s.state === "ready" ? "Data ready" : statusLine(s)}</span>
      {s.state === "error" && <button type="button" className={styles.link} onClick={retry}>Retry</button>}
    </span>
  );
}

function Step({ label, state, status }: { label: string; state: "done" | "active" | "todo"; status: EngineStatus }) {
  const pct = percent(status);
  return (
    <li className={styles.step} data-step={state} aria-current={state === "active" ? "step" : undefined}>
      <span className={styles.mark} aria-hidden="true">{state === "done" ? "✓" : state === "active" ? "" : ""}</span>
      <span className={styles.stepBody}>
        <span className={styles.stepLabel}>{label}{state === "done" && <span className={styles.sr}> (done)</span>}</span>
        {state === "active" && (
          <>
            <span className={styles.bar} role="progressbar" aria-label={`${label} progress`} aria-valuemin={0} aria-valuemax={100} {...(pct !== null ? { "aria-valuenow": pct } : {})}>
              <span className={pct === null ? styles.indeterminate : styles.fill} style={pct === null ? undefined : { width: `${pct}%` }} />
            </span>
            {status.total ? <span className={styles.count}>{(status.done ?? 0).toLocaleString()} of {status.total.toLocaleString()}</span> : null}
          </>
        )}
      </span>
    </li>
  );
}

// Ticks locally between polls so the timer moves smoothly instead of jumping every 1.5s.
function useElapsed(s: EngineStatus): number {
  const [extra, setExtra] = useState(0);
  useEffect(() => { setExtra(0); const t = setInterval(() => setExtra((x) => x + 1), 1000); return () => clearInterval(t); }, [s.elapsedS, s.state]);
  return s.elapsedS + extra;
}

export function EngineBuffer({ status, queued, onCancel, onRetry, retrying }: {
  status: EngineStatus; queued: boolean; onCancel: () => void; onRetry: () => void; retrying?: boolean;
}) {
  const elapsed = useElapsed(status);
  if (status.state === "error") {
    const where = status.phase ? ` while loading ${PHASE_LABEL[status.phase]?.toLowerCase() ?? status.phase}` : "";
    return (
      <section className={`${styles.panel} ${styles.errorPanel}`} role="alert" aria-label="Data engine error">
        <h3 className={styles.title}>The data engine stopped{where}</h3>
        <p className={styles.lead}>Your rules are saved. {queued ? "Your queued run was paused. " : ""}Retrying usually fixes a one-off network or cache problem.</p>
        <div className={styles.actions}>
          <Button variant="primary" size={36} onClick={onRetry} disabled={retrying}>{retrying ? "Retrying…" : "Retry"}</Button>
          {queued && <Button variant="ghost" size={36} onClick={onCancel}>Cancel run</Button>}
        </div>
        {(status.error || status.log?.length) ? (
          <details className={styles.details}>
            <summary>Show details</summary>
            {status.error && <p className={styles.mono}>{status.error}</p>}
            {status.log?.length ? <pre className={styles.log} tabIndex={0}>{status.log.join("\n")}</pre> : null}
          </details>
        ) : null}
      </section>
    );
  }

  // Not running and nobody here will start it (ENGINE_MANAGED=0): say so plainly instead of promising a start that won't come.
  if (status.state === "stopped" && !status.managed) {
    return (
      <section className={`${styles.panel} ${styles.errorPanel}`} role="status" aria-live="polite" aria-label="Data engine status" data-queued={queued || undefined}>
        <h3 className={styles.title}>The data engine is not running</h3>
        <p className={styles.lead}>
          This app is set to leave the engine to you (<code>ENGINE_MANAGED=0</code>). Start it, and {queued ? "your queued run will start automatically" : "results will appear here"}.
        </p>
        {queued && <div className={styles.actions}><Button variant="ghost" size={36} onClick={onCancel}>Cancel run</Button></div>}
      </section>
    );
  }

  const starting = status.state === "starting" || status.state === "stopped";
  return (
    <section className={styles.panel} role="status" aria-live="polite" aria-busy="true" aria-label="Data engine status" data-queued={queued || undefined}>
      <div className={styles.head}>
        <span className={styles.spinner} aria-hidden="true" />
        <h3 className={styles.title}>{starting ? "Starting the data engine" : "Loading market data"}</h3>
        <span className={styles.elapsed}>{formatElapsed(elapsed)}</span>
      </div>
      <p className={styles.lead}>
        {queued ? "Your run is queued and will start automatically." : "Your rules are saved. Results appear here when the data is ready."}
      </p>
      {!starting && status.phaseIndex !== null && <p className={styles.stepOf}>Step {status.phaseIndex + 1} of {status.phases.length}</p>}
      {!starting && (
        <ol className={styles.steps} aria-label="Loading steps">
          {status.phases.map((p, i) => (
            <Step key={p} label={PHASE_LABEL[p] ?? p} status={status}
              state={status.phaseIndex === null ? "todo" : i < status.phaseIndex ? "done" : i === status.phaseIndex ? "active" : "todo"} />
          ))}
        </ol>
      )}
      <p className={styles.hint}>The first start loads about 2,300 stocks and usually takes a few minutes. After that, runs are instant.</p>
      {queued && <div className={styles.actions}><Button variant="ghost" size={36} onClick={onCancel}>Cancel run</Button></div>}
      <div className={styles.skeleton} aria-hidden="true"><span /><span /><span /><span /></div>
    </section>
  );
}

// The screen itself is running (the engine is ready). The first run after a start builds its in-memory indexes over ~2,300
// stocks and takes about half a minute, so say so instead of showing an empty page; later runs are a couple of seconds.
export function RunningPanel({ firstRun }: { firstRun: boolean }) {
  const [sec, setSec] = useState(0);
  useEffect(() => { const t = setInterval(() => setSec((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  return (
    <section className={styles.panel} role="status" aria-live="polite" aria-busy="true" aria-label="Running your screen">
      <div className={styles.head}>
        <span className={styles.spinner} aria-hidden="true" />
        <h3 className={styles.title}>Running your screen</h3>
        <span className={styles.elapsed}>{formatElapsed(sec)}</span>
      </div>
      <p className={styles.lead}>The data is ready. Checking every stock against your rules{firstRun ? "; the first run after a start takes about half a minute" : ""}.</p>
      <div className={styles.skeleton} aria-hidden="true"><span /><span /><span /><span /></div>
    </section>
  );
}

export { emptyStatus };
