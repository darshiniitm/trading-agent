"use client";
import { useState } from "react";
import type { ScreenSpec } from "spec";
import { describeApiError } from "@/lib/apiError";

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
  onAnswered: (path: string, spec: ScreenSpec | null) => void;
}) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const numeric = Number(value);
      const res = await fetch(`/api/drafts/${draftId}/answers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: item.path, value: Number.isNaN(numeric) ? value : numeric }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(describeApiError(body, "could not save answer"));
        return;
      }
      onAnswered(item.path, body.spec ?? null);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <label>
        {index}. {item.question}
        <input aria-label={`answer for ${item.path}`} value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
      <button type="button" onClick={save} disabled={saving || value === ""}>
        Save answer
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
