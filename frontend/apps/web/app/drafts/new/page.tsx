"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Condition, ScreenSpec } from "spec";
import { ConditionRow } from "@/components/ConditionRow";

type LiquidityChoice = "confirm_10cr" | "custom" | "none" | null;

export default function NewDraftPage() {
  const router = useRouter();
  const [draftId, setDraftId] = useState<number | null>(null);
  const [structure, setStructure] = useState<"literal" | "t1_literal" | "">("");
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [liquidity, setLiquidity] = useState<LiquidityChoice>(null);
  const [liquidityCustom, setLiquidityCustom] = useState("");
  const [hypothesis, setHypothesis] = useState("");
  const [killCriterion, setKillCriterion] = useState("");
  const [blockedReason, setBlockedReason] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/drafts", { method: "POST" })
      .then((r) => r.json())
      .then((d) => setDraftId(d.draft_id));
  }, []);

  function addCondition() {
    const nextId = `C${conditions.length + 1}`;
    setConditions([...conditions, { id: nextId, role: "filter", kind: "field", name: "", params: {}, op: "", value: null }]);
  }

  function buildSpec(): ScreenSpec | null {
    if (!structure) return null;
    const allConditions: Condition[] = [...conditions];
    if (liquidity === "confirm_10cr" || liquidity === "custom") {
      allConditions.push({
        id: `C${allConditions.length + 1}`, role: "filter", kind: "field", name: "traded_value_cr",
        params: { window: "1W" }, op: ">=", value: liquidity === "confirm_10cr" ? 10 : Number(liquidityCustom),
      });
    }
    return {
      spec_version: 4, structure, timeframe: "1W", selection_point: null,
      conditions: allConditions, stop: null, risk_cap_pct: null, near_miss: null,
    };
  }

  async function saveSpec() {
    const spec = buildSpec();
    if (!draftId || !spec) return;
    await fetch(`/api/drafts/${draftId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ structure, specJson: JSON.stringify(spec), hypothesis, killCriterion }),
    });
  }

  async function confirm() {
    if (!structure) return setBlockedReason("Choose a structure");
    if (liquidity === null) return setBlockedReason("Answer the liquidity question");
    if (!hypothesis) return setBlockedReason("Add a hypothesis");
    if (!killCriterion) return setBlockedReason("Add a kill criterion");
    setBlockedReason(null);
    await saveSpec();
    const res = await fetch(`/api/drafts/${draftId}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ as_of: new Date().toISOString().slice(0, 10) }),
    });
    if (!res.ok) {
      const body = await res.json();
      setBlockedReason(body.error ?? "confirm failed");
      return;
    }
    const { watchlist_id } = await res.json();
    router.push(`/watchlists/${watchlist_id}`);
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

      <button type="button" onClick={saveSpec}>Dry run</button>
      <button type="button" onClick={confirm}>Confirm and assign Prompt ID</button>
      {blockedReason && <p role="alert">{blockedReason}</p>}
    </main>
  );
}
