"use client";
import { useState } from "react";
import type { ScreenSpec } from "spec";
import { describeApiError } from "@/lib/apiError";

// A plain decimal number (optionally signed, optionally fractional) and
// nothing else: Number() alone would turn " " into 0 and "0x10" into 16.
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

// Paths whose answer is one of a fixed set of words rather than a number.
// Rendered as a select whose first option is an empty "— choose —", so the
// app still never pre-selects an answer (D6).
const CHOICES: Record<string, string[]> = {
  structure: ["literal", "t1_literal"],
  "selection_point.at": ["open", "close"],
};

export function parseAnswer(text: string): number | string {
  const trimmed = text.trim();
  return DECIMAL.test(trimmed) ? Number(trimmed) : trimmed;
}

// One row per compileDraft()/applyAnswer() needs_input item. The input starts
// empty — no suggested value, per D6 ("no pre-filled value" even for a
// question the model itself raised) — and posts straight to
// POST /api/drafts/:draftId/answers, whose response already carries the
// updated spec and the remaining needs_input list, so the caller never has
// to re-fetch the draft to learn what changed.
export function QuestionRow({
  index,
  item,
  draftId,
  onAnswered,
}: {
  index: number;
  item: { path: string; question: string };
  draftId: number;
  onAnswered: (path: string, spec: ScreenSpec | null, needsInput: { path: string; question: string }[] | null) => void;
}) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choices = CHOICES[item.path];

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/drafts/${draftId}/answers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: item.path, value: choices ? value : parseAnswer(value) }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(describeApiError(body, "could not save answer"));
        return;
      }
      onAnswered(item.path, body.spec ?? null, Array.isArray(body.needs_input) ? body.needs_input : null);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <label>
        {index}. {item.question}
        {choices ? (
          <select aria-label={`answer for ${item.path}`} value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="">— choose —</option>
            {choices.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        ) : (
          <input aria-label={`answer for ${item.path}`} value={value} onChange={(e) => setValue(e.target.value)} />
        )}
      </label>
      <button type="button" onClick={save} disabled={saving || value.trim() === ""}>
        Save answer
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
