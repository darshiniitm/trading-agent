"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Condition, ScreenSpec } from "spec";
import { ConditionRow } from "@/components/ConditionRow";
import { describeApiError } from "@/lib/apiError";

type LiquidityChoice = "confirm_10cr" | "custom" | "none" | null;

export default function NewDraftPage() {
  const router = useRouter();
  const [draftId, setDraftId] = useState<number | null>(null);
  const [structure, setStructure] = useState<"literal" | "t1_literal" | "">("");
  const [conditions, setConditions] = useState<Condition[]>([]);
  const nextConditionNo = useRef(1); // monotonic — never reused, unlike conditions.length (removing then re-adding would collide)

  const [hasSelectionPoint, setHasSelectionPoint] = useState(false);
  const [sessionOfWeek, setSessionOfWeek] = useState("1");
  const [selectionAt, setSelectionAt] = useState<"open" | "close">("open");
  const [stopFrom, setStopFrom] = useState("");
  const [hasRiskCap, setHasRiskCap] = useState(false);
  const [riskCapPct, setRiskCapPct] = useState("");
  const [hasNearMiss, setHasNearMiss] = useState(false);
  const [nearMissMaxFailed, setNearMissMaxFailed] = useState("0");

  const [liquidity, setLiquidity] = useState<LiquidityChoice>(null);
  const [liquidityCustom, setLiquidityCustom] = useState("");
  const [hypothesis, setHypothesis] = useState("");
  const [killCriterion, setKillCriterion] = useState("");

  const [dryRunResult, setDryRunResult] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/drafts", { method: "POST" })
      .then((r) => r.json())
      .then((d) => setDraftId(d.draft_id));
  }, []);

  function addCondition() {
    const nextId = `C${nextConditionNo.current}`;
    nextConditionNo.current += 1;
    setConditions([...conditions, { id: nextId, role: "filter", kind: "field", name: "", params: {}, op: "", value: null }]);
  }

  function buildSpec(): ScreenSpec | null {
    if (!structure) return null;
    const allConditions: Condition[] = [...conditions];
    if (liquidity === "confirm_10cr" || liquidity === "custom") {
      allConditions.push({
        id: `C${nextConditionNo.current}`, role: "filter", kind: "field", name: "traded_value_cr",
        params: { window: "1W" }, op: ">=", value: liquidity === "confirm_10cr" ? 10 : Number(liquidityCustom),
      });
    }
    return {
      spec_version: 4, structure, timeframe: "1W",
      selection_point: hasSelectionPoint ? { session_of_week: Number(sessionOfWeek), at: selectionAt } : null,
      conditions: allConditions,
      stop: stopFrom.trim() ? { from: stopFrom.trim() } : null,
      risk_cap_pct: hasRiskCap && riskCapPct !== "" ? Number(riskCapPct) : null,
      near_miss: hasNearMiss ? { max_failed: Number(nearMissMaxFailed) } : null,
    };
  }

  function gateReason(): string | null {
    if (!structure) return "Choose a structure";
    if (conditions.length === 0) return "Add at least one condition";
    if (liquidity === null) return "Answer the liquidity question";
    if (liquidity === "custom" && (liquidityCustom === "" || Number.isNaN(Number(liquidityCustom)))) {
      return "Enter a valid liquidity floor";
    }
    if (!hypothesis) return "Add a hypothesis";
    if (!killCriterion) return "Add a kill criterion";
    return null;
  }
  const blocked = gateReason();

  async function saveSpec(): Promise<ScreenSpec | null> {
    const spec = buildSpec();
    if (!draftId || !spec) return null;
    await fetch(`/api/drafts/${draftId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ structure, specJson: JSON.stringify(spec), hypothesis, killCriterion }),
    });
    return spec;
  }

  async function dryRun() {
    setDryRunResult(null);
    const spec = await saveSpec();
    if (!draftId || !spec) return setDryRunResult("Choose a structure and add a condition first");
    const res = await fetch(`/api/drafts/${draftId}/dry-run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ as_of: new Date().toISOString().slice(0, 10) }),
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
      await saveSpec();
      const res = await fetch(`/api/drafts/${draftId}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ as_of: new Date().toISOString().slice(0, 10) }),
      });
      const body = await res.json();
      if (!res.ok) {
        setBlockedReason(describeApiError(body, "confirm failed"));
        return;
      }
      router.push(`/watchlists/${body.watchlist_id}`);
    } finally {
      setConfirming(false);
    }
  }

  return (
    <main>
      <h1>Draft {draftId ?? "…"} · not yet numbered</h1>

      <label>
        Structure
        <select aria-label="structure" value={structure} onChange={(e) => setStructure(e.target.value as any)}>
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
              <select aria-label="selection at" value={selectionAt} onChange={(e) => setSelectionAt(e.target.value as "open" | "close")}>
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
