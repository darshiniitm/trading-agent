"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { InterpretationView, type ProgramViewData } from "@/components/InterpretationView";
import { describeApiError } from "@/lib/apiError";
import { Button } from "@/ui/Button";
import { Card } from "@/ui/Card";
import { Banner } from "@/ui/Banner";
import styles from "./DraftEditor.module.css";

// One draft = a prompt in the user's own words, read line by line into rules and run straight away.
// Anything the prompt left open is filled in and shown as an editable chip; nothing is asked and nothing
// blocks the run. Hypothesis, kill criterion and extra filters are optional add-ons. Saving the prompt
// assigns its numeric Prompt ID and starts its forward record (docs/prompt-interpreter-spec.md).
export function DraftEditor({ initialDraftId }: { initialDraftId?: number }) {
  const router = useRouter();
  const [draftId, setDraftId] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draftStatus, setDraftStatus] = useState<string | null>(null);
  const [hasProgram, setHasProgram] = useState(false);
  const [promptText, setPromptText] = useState("");
  const [hypothesis, setHypothesis] = useState("");
  const [killCriterion, setKillCriterion] = useState("");
  const [view, setView] = useState<ProgramViewData | null>(null);
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
        setDraftStatus(draft.status);
        setPromptText(draft.promptText ?? "");
        setHypothesis(draft.hypothesis ?? "");
        setKillCriterion(draft.killCriterion ?? "");
        setHasProgram(!!draft.program);
        setDraftId(draft.draftId);
      })
      .catch((err: Error) => setLoadError(err.message));
  }, [initialDraftId]);

  // The as_of the screen runs on: the engine's latest bar date. Degrades to today if health is unavailable.
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
    return new Date().toISOString().slice(0, 10);
  }

  function gateReason(): string | null {
    if (!view) return "Read your prompt first";
    if (!view.ready) return view.problems.join("; ");
    return null;
  }
  const blocked = gateReason();

  async function confirm() {
    const reason = gateReason();
    if (reason) return setBlockedReason(reason);
    setBlockedReason(null);
    setConfirming(true);
    try {
      // Never confirm on top of a save that didn't land: the server confirms what it last stored.
      const save = await fetch(`/api/drafts/${draftId}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ hypothesis, killCriterion }),
      });
      if (!save.ok) {
        setBlockedReason(`Could not save the draft: ${describeApiError(await save.json().catch(() => null), `save failed (${save.status})`)}`);
        return;
      }
      const asOf = await resolveAsOf();
      const res = await fetch(`/api/drafts/${draftId}/confirm`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ as_of: asOf }),
      });
      const body = await res.json();
      if (!res.ok) {
        setBlockedReason(describeApiError(body, "confirm failed"));
        return;
      }
      // The prompt is confirmed even when post-confirm engine work (arm registration, first selection,
      // retiring a superseded parent's arm) failed — tell the user before leaving the page.
      // The warning travels to the watchlist as a banner (?notice=) instead of a native alert.
      const notice = body.selection_warning ? `?notice=${encodeURIComponent(String(body.selection_warning))}` : "";
      router.push(`/watchlists/${body.watchlist_id}${notice}`);
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
      {draftStatus && draftStatus !== "open" && <Banner role="status">This draft is {draftStatus}; it can no longer be confirmed.</Banner>}

      <Card title="Your prompt">
        <textarea aria-label="prompt text" rows={6} value={promptText} onChange={(e) => setPromptText(e.target.value)} />
      </Card>

      {draftId && (
        <InterpretationView draftId={draftId} promptText={promptText} hasProgram={hasProgram} onViewChange={setView} onPromptTextChange={setPromptText}
          addonsExtra={
            <fieldset>
              <legend>Forward-test notes (optional)</legend>
              <label className={styles.stack}>
                Hypothesis
                <textarea aria-label="hypothesis" value={hypothesis} onChange={(e) => setHypothesis(e.target.value)} />
              </label>
              <label className={styles.stack}>
                Kill criterion
                <textarea aria-label="kill criterion" value={killCriterion} onChange={(e) => setKillCriterion(e.target.value)} />
              </label>
            </fieldset>
          } />
      )}

      <div className={styles.saveBar}>
        <Button variant="primary" size={44} onClick={confirm} disabled={!!blocked || confirming} title={blocked ?? undefined}>
          {confirming ? "Saving…" : "Save and assign Prompt ID"}
        </Button>
        {(blocked || blockedReason) && <span role="alert" className={styles.reason}>{blockedReason ?? blocked}</span>}
      </div>
    </main>
  );
}
