export function buildCompilerPrompt(promptText: string, catalog: unknown[], structures: unknown[]): { system: string; user: string } {
  const structureNames = (structures as any[]).map((s) => s.structure);
  const system = `You turn a trader's plain-English screening prompt into a structured JSON spec. You read ONLY what the catalog below can compute, and you NEVER invent, default or guess a value — numeric or text.

CATALOG (the only fields/indicators/ops you may use):
${JSON.stringify(catalog)}

STRUCTURES (choose exactly one, or null if the prompt doesn't make it clear):
${JSON.stringify(structureNames)}
- "literal": a weekly closing-price signal, checked once on the completed Friday bar.
- "t1_literal": something that can happen DURING the week, or over a rolling multi-day window.

RULES (do not violate any of these):
1. Never invent, default, or suggest a value. Every value you place anywhere in the output — numbers AND text alike: each of a condition's params (e.g. a length, a multiplier, a price source like "close", a window like "1W"), a condition's value, risk_cap_pct, near_miss.max_failed, selection_point.session_of_week, selection_point.at, t1_window.length_sessions, t1_window.offsets — MUST have a matching entry in "source_phrases", keyed by its exact dotted path (e.g. "conditions.0.params.length", "conditions.0.params.source", "selection_point.at", "risk_cap_pct", "t1_window.offsets.0"). The only fields that need no source phrase are a condition's id, role, kind, name, op and dir, and stop.from. If the prompt doesn't state a value, leave it out and ask for it in "needs_input" instead.
2. If a condition names something not in the catalog, put the exact text in "unsupported" with a short reason, and do NOT include it in "conditions".
3. If a condition is named but is missing one of the catalog's required params, still include the condition in "conditions" (with that key simply absent from "params"), and add a "needs_input" item with "path" pointing at the exact missing value and a plain, neutral question — NEVER suggest or imply a value in the question text.
4. NEVER ask about liquidity in "needs_input" under any circumstance — the app always asks that itself, separately, outside this compiler.
5. Every "path" in "source_phrases" and "needs_input" must be exactly one of these forms (N is a 0-based index; a conditions index must point at an existing entry of "conditions"): "structure", "risk_cap_pct", "selection_point.session_of_week", "selection_point.at", "near_miss.max_failed", "t1_window.length_sessions", "t1_window.offsets.N", "conditions.N.params.<param name>", "conditions.N.value", "conditions.N.value.N". Any other path is rejected.
6. Respond with ONLY one JSON object, no prose before or after it, matching exactly this shape:
{"structure": "literal"|"t1_literal"|null, "conditions": [{"id": "C1", "role": "filter"|"event"|"stop", "kind": "field"|"indicator", "name": "...", "params": {}, "op": "...", "value": null, "dir": null}], "selection_point": {"session_of_week": 1-5, "at": "open"|"close"}|null, "stop": {"from": "<condition id>"}|null, "risk_cap_pct": number|null, "near_miss": {"max_failed": number}|null, "t1_window": {"length_sessions": number, "offsets": [number]}|null, "source_phrases": [{"path": "...", "phrase": "..."}], "needs_input": [{"path": "...", "question": "..."}], "unsupported": [{"text": "...", "reason": "..."}]}`;

  const user = `Prompt:\n"""\n${promptText}\n"""`;
  return { system, user };
}

export function buildRetryUser(user: string, errors: string[]): string {
  return `${user}\n\nYour previous answer had these problems — fix every one of them and respond again with only the corrected JSON object, no other text:\n${errors.map((e) => `- ${e}`).join("\n")}`;
}
