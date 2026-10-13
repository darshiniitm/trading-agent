# Prompt Screener — Frontend Phase 3 Implementation Plan (prompt compiler)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build frontend-plan §7 P3 / backend-plan §3 — a Node-side prompt compiler (Claude API) that reads a user's free-text prompt into a draft spec containing **only** values traceable to the text, flags every missing required value as a plain question with no suggested answer, flags anything the engine's catalog can't compute as unsupported, and gates confirm until both lists are empty. This replaces nothing from Phase 1's manual condition-row builder — it's a second, parallel way to arrive at the exact same `ScreenSpec` shape, which the rest of the pipeline (dry-run, confirm, weekly screen, select/validate) doesn't need to know or care which path produced it.

**Architecture:** A pure, hermetically-testable compiler core (`src/server/compiler/`) that never touches the network directly — every model call goes through an injectable `callModel` function, mirroring the `fetchFn` seam Phases 1–2 already use for the engine. The real implementation calls `@anthropic-ai/sdk`. A deterministic, non-LLM traceability check is the actual enforcement of "no invented values" (backend plan §3: "This test is not left to the model").

**Tech Stack:** Adds `@anthropic-ai/sdk` to `apps/web`'s dependencies. Everything else matches Phases 1–2 (Next.js, zod, better-sqlite3, vitest).

**Spec:** `docs/prompt-screener-frontend-plan.md` v3.2 §3.2 (New prompt screen: "Read my prompt", "How your prompt was read", "Questions for you", unsupported block); `docs/prompt-screener-backend-plan.md` v3.2 §3 (prompt compiler), §2.1 (spec shape — unchanged), §10 (no-app-supplied-values / liquidity-exception tests). Catalog and structures are read from the already-implemented `GET /conditions` / `GET /structures` (see `engine/conditions/catalog.py`, `engine/structures.py` in the `prompt-screener-engine` worktree) exactly as they exist today — this plan does not change the engine.

## Global Constraints

- **The engine's catalog/structures are the single source of truth for what the compiler may name**, fetched live via the already-implemented `GET /conditions` / `GET /structures` — the compiler never hardcodes a second copy of the condition list.
- **No parameter or condition value is ever invented (D6).** This is enforced by a **deterministic, non-LLM** post-check (`assertTraceable`, Task 3) that walks every numeric leaf of the model's own output and requires a matching `source_phrases` entry — never left to the model's own say-so, per backend plan §3's explicit instruction.
- **Liquidity is never a `needs_input` item from the compiler (D3).** It is always asked by the app directly, unchanged from Phase 1's manual-form fieldset. A compiler output that raises a liquidity question is rejected and retried, same as any other validation failure.
- **`value_origin` is tracked at condition-row granularity, not per-param.** Phase 1's `prompt_conditions` schema stores one `value_origin` per condition row (not per value inside it). This plan's rule: a condition is `'prompt'`-origin only if **every** numeric leaf inside it was traceable to a `source_phrase`; if the user supplied even one missing piece via a `needs_input` answer, the whole row is `'user_answer'`. This is a documented narrowing of backend plan §8.4's per-value phrasing to fit the schema that already exists — flagged here rather than silently assumed.
- **Exactly one retry.** A model response that fails JSON parsing, zod validation, catalog validation, or the traceability check is retried once with the errors appended to the prompt; a second failure is a 422 (`CompileError`), never a silent third attempt.
- **Every model call goes through the injectable `callModel` seam.** No test in this plan holds a real `ANTHROPIC_API_KEY` or makes a real network call — same hermetic-test discipline Phases 1–2 use for the engine's `fetchFn`.
- **The Task 12 regression suite is a representative, hermetic subset**, not backend plan §10's "at least 20 prompts against a live model." That needs a real API key and is an explicit, flagged manual follow-up — the same honesty pattern this repo already uses for Literal's `replay_horizons()` ("not yet run, needs a real network pull").
- **Nothing from Phase 1's manual draft form is removed.** A draft can still be built entirely by hand; the compiler is an alternative way to pre-fill the same `structure`/`specJson`/`hypothesis` fields on `prompt_drafts`, after which Phase 1's existing dry-run/confirm code paths are unchanged.

## Review Focus

- **The model's JSON response doesn't parse, or fails `CompileOutputSchema`, on the first attempt.** Expected: retried once with the specific errors appended; a second failure returns a 422 with nothing written to the draft's `structure`/`spec_json` (only a `compilations` row recording the failure). Covered in Task 6 and Task 7.
- **The model includes a numeric value with no matching `source_phrases` entry.** Expected: `assertTraceable` rejects it before it ever reaches the draft; retried once; 422 on persistent failure — never silently accepted into a confirmable spec. Covered in Task 3 and Task 6.
- **The model raises a `needs_input` question about liquidity.** Expected: rejected by the catalog/liquidity check, forcing a retry — a liquidity question never appears as a derived compiler question (it's always the app's own fixed fieldset). Covered in Task 6.
- **A condition names something outside the catalog (e.g. "MACD crossover" or "50-day moving average").** Expected: it lands in `unsupported` with the exact text and a reason, is never silently dropped or swapped for a similar catalog entry, and the New-prompt page shows a visible red block that blocks confirm until the condition is removed from the prompt and re-compiled. Covered in Task 7 (service) and Task 11 (UI gate).
- **The user answers every `needs_input` question but leaves hypothesis or kill criterion blank (or the reverse).** Expected: confirm stays blocked with the one true reason ("Add a hypothesis", not a generic "cannot confirm"), exactly mirroring Phase 1's own manual-form gate wording. Covered in Task 9 and Task 11.

---

## File Structure

```
frontend/
  apps/web/
    package.json                                        (MODIFY — add @anthropic-ai/sdk)
    src/server/db/
      migrations/0003_compiler.sql                       (NEW — compilations table, prompt_drafts.source_phrases_json/unsupported_json)
      schema.ts                                          (MODIFY — compilations table, promptDrafts gains two columns)
    src/server/
      drafts.ts                                          (MODIFY — DraftRow/rowToDraft/updateDraft gain needsInput/sourcePhrases/unsupported)
      compiler/
        traceability.ts                                  (NEW)
        promptBuilder.ts                                 (NEW)
        callModel.ts                                     (NEW)
        compile.ts                                       (NEW)
      compileDraft.ts                                    (NEW)
      mergeAnswer.ts                                     (NEW)
      confirm.ts                                         (MODIFY — confirm gate + per-condition value_origin/source_phrase)
    app/
      api/drafts/[draftId]/compile/route.ts               (NEW — POST)
      api/drafts/[draftId]/answers/route.ts                (NEW — POST)
      drafts/new/page.tsx                                 (MODIFY — "Read my prompt", how-it-was-read table, questions, unsupported block)
  packages/spec/
    src/index.ts                                          (MODIFY — CompileOutputSchema + related schemas/types)
  tests/ (apps/web/tests/)
    spec-compile-schema.test.ts
    migrate-p3.test.ts
    traceability.test.ts
    promptBuilder.test.ts
    compile.test.ts
    compileDraft.test.ts
    mergeAnswer.test.ts
    confirm-compiler-origin.test.ts
    confirm-gate.test.ts
    compiler-regression.test.ts
    components/ReadMyPrompt.test.tsx (optional — folded into the page test if simpler, see Task 10)
```

---

### Task 1: `packages/spec` — `CompileOutputSchema` and related schemas

**Files:**
- Modify: `frontend/packages/spec/src/index.ts`
- Test: `frontend/apps/web/tests/spec-compile-schema.test.ts`

**Interfaces:**
- Consumes: `ConditionSchema`, `SelectionPointSchema`, `StopSchema`, `NearMissSchema`, `T1WindowSchema` (Phase 1, unchanged).
- Produces: `SourcePhraseSchema`/`SourcePhrase`, `NeedsInputItemSchema`/`NeedsInputItem`, `UnsupportedItemSchema`/`UnsupportedItem`, `CompileOutputSchema`/`CompileOutput` — the exact JSON shape the compiler model must emit.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/spec-compile-schema.test.ts
import { describe, expect, it } from "vitest";
import { CompileOutputSchema } from "spec";

describe("CompileOutputSchema", () => {
  it("accepts a fully-known literal output", () => {
    const out = CompileOutputSchema.parse({
      structure: "literal",
      conditions: [{ id: "C1", role: "event", kind: "indicator", name: "vstop", params: { length: 10, mult: 2, source: "close" }, op: "flip", dir: "long" }],
      selection_point: { session_of_week: 1, at: "open" },
      stop: { from: "C1" }, risk_cap_pct: null, near_miss: null, t1_window: null,
      source_phrases: [
        { path: "structure", phrase: "weekly close" },
        { path: "conditions.0.params.length", phrase: "VStop 10" },
        { path: "conditions.0.params.mult", phrase: "multiplier 2" },
        { path: "selection_point.session_of_week", phrase: "Monday" },
      ],
      needs_input: [], unsupported: [],
    });
    expect(out.conditions).toHaveLength(1);
  });

  it("accepts a partial output with a condition missing params, flagged in needs_input", () => {
    const out = CompileOutputSchema.parse({
      structure: "literal",
      conditions: [{ id: "C1", role: "event", kind: "indicator", name: "vstop", params: {}, op: "flip", dir: "long" }],
      selection_point: null, stop: null, risk_cap_pct: null, near_miss: null, t1_window: null,
      source_phrases: [],
      needs_input: [{ path: "conditions.0.params.length", question: "What VStop length?" }],
      unsupported: [],
    });
    expect(out.needs_input).toHaveLength(1);
  });

  it("accepts structure: null for an unclear prompt", () => {
    const out = CompileOutputSchema.parse({
      structure: null, conditions: [], selection_point: null, stop: null, risk_cap_pct: null, near_miss: null, t1_window: null,
      source_phrases: [], needs_input: [], unsupported: [{ text: "something vague", reason: "not a recognisable condition" }],
    });
    expect(out.structure).toBeNull();
  });

  it("rejects a needs_input item with no path or question", () => {
    expect(() =>
      CompileOutputSchema.parse({
        structure: "literal", conditions: [], selection_point: null, stop: null, risk_cap_pct: null, near_miss: null, t1_window: null,
        source_phrases: [], needs_input: [{ path: "" }], unsupported: [],
      })
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- spec-compile-schema`
Expected: FAIL — `CompileOutputSchema` isn't exported yet.

- [ ] **Step 3: Write the implementation**

```ts
// packages/spec/src/index.ts — append
export const SourcePhraseSchema = z.object({ path: z.string().min(1), phrase: z.string().min(1) });
export type SourcePhrase = z.infer<typeof SourcePhraseSchema>;

export const NeedsInputItemSchema = z.object({ path: z.string().min(1), question: z.string().min(1) });
export type NeedsInputItem = z.infer<typeof NeedsInputItemSchema>;

export const UnsupportedItemSchema = z.object({ text: z.string().min(1), reason: z.string().min(1) });
export type UnsupportedItem = z.infer<typeof UnsupportedItemSchema>;

export const CompileOutputSchema = z.object({
  structure: z.enum(["literal", "t1_literal"]).nullable(),
  conditions: z.array(ConditionSchema),
  selection_point: SelectionPointSchema.nullable(),
  stop: StopSchema.nullable(),
  risk_cap_pct: z.number().nullable(),
  near_miss: NearMissSchema.nullable(),
  t1_window: T1WindowSchema.nullable(),
  source_phrases: z.array(SourcePhraseSchema),
  needs_input: z.array(NeedsInputItemSchema),
  unsupported: z.array(UnsupportedItemSchema),
});
export type CompileOutput = z.infer<typeof CompileOutputSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w apps/web -- spec-compile-schema`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/packages/spec/src/index.ts frontend/apps/web/tests/spec-compile-schema.test.ts
git commit -m "feat(spec): CompileOutputSchema — the compiler's draft-spec-plus-provenance shape"
```

---

### Task 2: Migration `0003_compiler.sql` + `schema.ts` + `drafts.ts` gains needs_input/source_phrases/unsupported

**Files:**
- Create: `apps/web/src/server/db/migrations/0003_compiler.sql`
- Modify: `apps/web/src/server/db/schema.ts`, `apps/web/src/server/drafts.ts`
- Test: `apps/web/tests/migrate-p3.test.ts`, extend `apps/web/tests/drafts.test.ts`

**Interfaces:**
- Produces: a `compilations` table (backend plan §8.4, verbatim) and two new nullable columns on `prompt_drafts`: `source_phrases_json`, `unsupported_json`. `DraftRow` (Phase 1) grows `needsInput: NeedsInputItem[] | null`, `sourcePhrases: SourcePhrase[] | null`, `unsupported: UnsupportedItem[] | null`. `updateDraft`'s patch type grows `needsInputJson`, `sourcePhrasesJson`, `unsupportedJson`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/migrate-p3.test.ts
import { describe, expect, it } from "vitest";
import { createTestDb } from "@/server/db/test-db";

describe("0003_compiler migration", () => {
  it("creates compilations and the two new prompt_drafts columns", () => {
    const raw = createTestDb();
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toContain("compilations");
    const columns = (raw.prepare("PRAGMA table_info(prompt_drafts)").all() as { name: string }[]).map((c) => c.name);
    expect(columns).toContain("source_phrases_json");
    expect(columns).toContain("unsupported_json");
  });

  it("rejects invalid JSON in compilations.raw_json", () => {
    const raw = createTestDb();
    raw.prepare(`INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (1, 1, 'x', 'open', '2026-01-01', '2026-01-01')`).run();
    expect(() =>
      raw.prepare(`INSERT INTO compilations (draft_id, model, raw_json, created_at) VALUES (1, 'm', 'not json', '2026-01-01')`).run()
    ).toThrow();
  });
});
```

(Appended cases for Task 2's effect on `drafts.ts` are added at Step 5, inside the existing `tests/drafts.test.ts`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- migrate-p3.test`
Expected: FAIL — `compilations` doesn't exist yet.

- [ ] **Step 3: Write `0003_compiler.sql`**

```sql
-- apps/web/src/server/db/migrations/0003_compiler.sql
PRAGMA foreign_keys = ON;

ALTER TABLE prompt_drafts ADD COLUMN source_phrases_json TEXT CHECK (source_phrases_json IS NULL OR json_valid(source_phrases_json));
ALTER TABLE prompt_drafts ADD COLUMN unsupported_json TEXT CHECK (unsupported_json IS NULL OR json_valid(unsupported_json));

CREATE TABLE compilations (
  compilation_id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id       INTEGER NOT NULL REFERENCES prompt_drafts(draft_id),
  model          TEXT NOT NULL,
  raw_json       TEXT NOT NULL CHECK (json_valid(raw_json)),
  errors_json    TEXT CHECK (errors_json IS NULL OR json_valid(errors_json)),
  created_at     TEXT NOT NULL
);
```

(Because this plan's `compileDraft.ts`, Task 7, stores the model's raw text response — which is prose-wrapped JSON, not guaranteed valid JSON on a failed attempt — `raw_json` actually stores `JSON.stringify({ text: rawModelOutput })`, not the model's raw text directly, so the `json_valid` CHECK always holds even when the model's own output was garbage. Task 7 implements it this way; noted here so the CHECK's intent is clear from the DDL alone.)

- [ ] **Step 4: Add `compilations` to `schema.ts` and the two columns to `promptDrafts`**

```ts
// apps/web/src/server/db/schema.ts
// In the existing promptDrafts sqliteTable(...), add two fields:
export const promptDrafts = sqliteTable("prompt_drafts", {
  // ...all existing fields unchanged...
  sourcePhrasesJson: text("source_phrases_json"),
  unsupportedJson: text("unsupported_json"),
});

// Append a new table:
export const compilations = sqliteTable("compilations", {
  compilationId: integer("compilation_id").primaryKey({ autoIncrement: true }),
  draftId: integer("draft_id").notNull(),
  model: text("model").notNull(),
  rawJson: text("raw_json").notNull(),
  errorsJson: text("errors_json"),
  createdAt: text("created_at").notNull(),
});
```

- [ ] **Step 5: Extend `drafts.ts`'s `DraftRow`/`rowToDraft`/`updateDraft`**

```ts
// apps/web/src/server/drafts.ts
import type { NeedsInputItem, SourcePhrase, ScreenSpec, UnsupportedItem } from "spec";

export type DraftRow = {
  // ...all existing fields unchanged...
  needsInput: NeedsInputItem[] | null;
  sourcePhrases: SourcePhrase[] | null;
  unsupported: UnsupportedItem[] | null;
};

function rowToDraft(row: any): DraftRow {
  return {
    // ...all existing fields unchanged...
    needsInput: row.needs_input_json ? JSON.parse(row.needs_input_json) : null,
    sourcePhrases: row.source_phrases_json ? JSON.parse(row.source_phrases_json) : null,
    unsupported: row.unsupported_json ? JSON.parse(row.unsupported_json) : null,
  };
}

type DraftPatch = Partial<{
  title: string; promptText: string; structure: "literal" | "t1_literal"; specJson: string;
  hypothesis: string; killCriterion: string;
  needsInputJson: string; sourcePhrasesJson: string; unsupportedJson: string;
}>;

const COLUMN_BY_KEY: Record<keyof DraftPatch, string> = {
  title: "title", promptText: "prompt_text", structure: "structure", specJson: "spec_json",
  hypothesis: "hypothesis", killCriterion: "kill_criterion",
  needsInputJson: "needs_input_json", sourcePhrasesJson: "source_phrases_json", unsupportedJson: "unsupported_json",
};
```

(The rest of `createDraft`, `getDraft`, and `updateDraft`'s body — the SQL assembly loop keyed off `Object.keys(patch)` — is unchanged; it already works generically off `COLUMN_BY_KEY`.)

- [ ] **Step 6: Add the drafts.ts regression case and run tests**

```ts
// apps/web/tests/drafts.test.ts — append
describe("updateDraft — compiler fields", () => {
  it("stores and round-trips needsInputJson/sourcePhrasesJson/unsupportedJson", () => {
    const { raw, userId } = setup();
    const { draftId } = createDraft(raw, { userId });
    const updated = updateDraft(raw, draftId, {
      needsInputJson: JSON.stringify([{ path: "conditions.0.params.length", question: "What length?" }]),
      sourcePhrasesJson: JSON.stringify([{ path: "structure", phrase: "weekly close" }]),
      unsupportedJson: JSON.stringify([{ text: "MACD", reason: "not in catalog" }]),
    });
    expect(updated.needsInput).toEqual([{ path: "conditions.0.params.length", question: "What length?" }]);
    expect(updated.sourcePhrases).toEqual([{ path: "structure", phrase: "weekly close" }]);
    expect(updated.unsupported).toEqual([{ text: "MACD", reason: "not in catalog" }]);
  });
});
```

Run: `npm run test -w apps/web -- migrate-p3.test drafts.test`
Expected: PASS (3 new tests, all prior `drafts.test.ts` cases still pass)

- [ ] **Step 7: Commit**

```bash
git add frontend/apps/web/src/server/db/migrations/0003_compiler.sql frontend/apps/web/src/server/db/schema.ts frontend/apps/web/src/server/drafts.ts frontend/apps/web/tests/migrate-p3.test.ts frontend/apps/web/tests/drafts.test.ts
git commit -m "feat(web): compilations table + prompt_drafts.source_phrases_json/unsupported_json, drafts.ts extended"
```

---

### Task 3: `compiler/traceability.ts` — the deterministic no-invented-values check

**Files:**
- Create: `apps/web/src/server/compiler/traceability.ts`
- Test: `apps/web/tests/traceability.test.ts`

**Interfaces:**
- Produces: `numericLeafPaths(output): string[]` — every dotted path to a number inside `conditions[].value`/`conditions[].params`, `risk_cap_pct`, `near_miss.max_failed`, `selection_point.session_of_week`, `t1_window.length_sessions`/`t1_window.offsets[]`. `UntraceableValueError` (has `.paths: string[]`). `assertTraceable(output, sourcePhrases, answeredPaths?: string[]): void` — throws `UntraceableValueError` listing every numeric leaf path with no matching `source_phrases` entry and no matching entry in `answeredPaths`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/traceability.test.ts
import { describe, expect, it } from "vitest";
import { assertTraceable, numericLeafPaths, UntraceableValueError } from "@/server/compiler/traceability";

const BASE = {
  conditions: [
    { id: "C1", role: "event", kind: "indicator", name: "vstop", params: { length: 10, mult: 2, source: "close" }, op: "flip", dir: "long" },
    { id: "C2", role: "filter", kind: "field", name: "mcap_cr", params: {}, op: "between", value: [10000, 50000] },
  ],
  risk_cap_pct: 15, near_miss: { max_failed: 1 },
  selection_point: { session_of_week: 1, at: "open" }, t1_window: { length_sessions: 5, offsets: [0, 1] },
};

describe("numericLeafPaths", () => {
  it("finds every numeric leaf by its canonical path", () => {
    const paths = numericLeafPaths(BASE as any);
    expect(paths).toEqual(
      expect.arrayContaining([
        "conditions.0.params.length", "conditions.0.params.mult",
        "conditions.1.value.0", "conditions.1.value.1",
        "risk_cap_pct", "near_miss.max_failed", "selection_point.session_of_week",
        "t1_window.length_sessions", "t1_window.offsets.0", "t1_window.offsets.1",
      ])
    );
    // "source" (an enum string, not a number) must never appear as a leaf.
    expect(paths).not.toContain("conditions.0.params.source");
  });
});

describe("assertTraceable", () => {
  it("passes when every numeric leaf has a source phrase", () => {
    const phrases = [
      { path: "conditions.0.params.length", phrase: "x" }, { path: "conditions.0.params.mult", phrase: "x" },
      { path: "conditions.1.value.0", phrase: "x" }, { path: "conditions.1.value.1", phrase: "x" },
      { path: "risk_cap_pct", phrase: "x" }, { path: "near_miss.max_failed", phrase: "x" },
      { path: "selection_point.session_of_week", phrase: "x" },
      { path: "t1_window.length_sessions", phrase: "x" }, { path: "t1_window.offsets.0", phrase: "x" }, { path: "t1_window.offsets.1", phrase: "x" },
    ];
    expect(() => assertTraceable(BASE as any, phrases)).not.toThrow();
  });

  it("throws UntraceableValueError listing exactly the missing paths", () => {
    try {
      assertTraceable(BASE as any, []);
      throw new Error("expected assertTraceable to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UntraceableValueError);
      expect((err as any).paths).toContain("risk_cap_pct");
      expect((err as any).paths).toContain("conditions.0.params.length");
    }
  });

  it("accepts a path covered by answeredPaths instead of a source phrase", () => {
    const partial = { conditions: [{ id: "C1", role: "event", kind: "indicator", name: "vstop", params: {}, op: "flip", dir: "long" }], risk_cap_pct: null, near_miss: null, selection_point: null, t1_window: null };
    expect(() => assertTraceable(partial as any, [], ["conditions.0.params.length"])).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- traceability.test`
Expected: FAIL — `Cannot find module '@/server/compiler/traceability'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/server/compiler/traceability.ts

type TraceableOutput = {
  conditions: { value?: unknown; params?: Record<string, unknown> }[];
  risk_cap_pct?: number | null;
  near_miss?: { max_failed: number } | null;
  selection_point?: { session_of_week: number } | null;
  t1_window?: { length_sessions: number; offsets: number[] } | null;
};

export function numericLeafPaths(output: TraceableOutput): string[] {
  const paths: string[] = [];

  output.conditions.forEach((c, i) => {
    if (typeof c.value === "number") paths.push(`conditions.${i}.value`);
    if (Array.isArray(c.value)) {
      c.value.forEach((v, j) => { if (typeof v === "number") paths.push(`conditions.${i}.value.${j}`); });
    }
    for (const [key, v] of Object.entries(c.params ?? {})) {
      if (typeof v === "number") paths.push(`conditions.${i}.params.${key}`);
    }
  });

  if (typeof output.risk_cap_pct === "number") paths.push("risk_cap_pct");
  if (output.near_miss && typeof output.near_miss.max_failed === "number") paths.push("near_miss.max_failed");
  if (output.selection_point && typeof output.selection_point.session_of_week === "number") paths.push("selection_point.session_of_week");
  if (output.t1_window) {
    if (typeof output.t1_window.length_sessions === "number") paths.push("t1_window.length_sessions");
    output.t1_window.offsets.forEach((v, j) => { if (typeof v === "number") paths.push(`t1_window.offsets.${j}`); });
  }

  return paths;
}

export class UntraceableValueError extends Error {
  paths: string[];
  constructor(paths: string[]) {
    super(`values at these paths have no source phrase and no recorded user answer: ${paths.join(", ")}`);
    this.paths = paths;
  }
}

export function assertTraceable(
  output: TraceableOutput,
  sourcePhrases: { path: string }[],
  answeredPaths: string[] = []
): void {
  const known = new Set([...sourcePhrases.map((s) => s.path), ...answeredPaths]);
  const missing = numericLeafPaths(output).filter((p) => !known.has(p));
  if (missing.length > 0) throw new UntraceableValueError(missing);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w apps/web -- traceability.test`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/src/server/compiler/traceability.ts frontend/apps/web/tests/traceability.test.ts
git commit -m "feat(web): deterministic traceability check — no spec number without a source phrase or a user answer"
```

---

### Task 4: `compiler/promptBuilder.ts`

**Files:**
- Create: `apps/web/src/server/compiler/promptBuilder.ts`
- Test: `apps/web/tests/promptBuilder.test.ts`

**Interfaces:**
- Produces: `buildCompilerPrompt(promptText: string, catalog: unknown[], structures: unknown[]): { system: string; user: string }`; `buildRetryUser(user: string, errors: string[]): string`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/promptBuilder.test.ts
import { describe, expect, it } from "vitest";
import { buildCompilerPrompt, buildRetryUser } from "@/server/compiler/promptBuilder";

describe("buildCompilerPrompt", () => {
  it("embeds the catalog and the prompt text, and states the no-invented-values and liquidity rules", () => {
    const catalog = [{ kind: "indicator", name: "vstop", required_params: [{ name: "length" }] }];
    const { system, user } = buildCompilerPrompt("Buy when VStop flips up", catalog, [{ structure: "literal" }]);
    expect(system).toContain("vstop");
    expect(system).toContain("source_phrases");
    expect(system).toMatch(/never.*liquidity/i);
    expect(system).toMatch(/never invent/i);
    expect(user).toContain("Buy when VStop flips up");
  });
});

describe("buildRetryUser", () => {
  it("appends the errors to the original user prompt, asking for corrected JSON only", () => {
    const retried = buildRetryUser("original prompt text", ["risk_cap_pct: no source phrase"]);
    expect(retried).toContain("original prompt text");
    expect(retried).toContain("risk_cap_pct: no source phrase");
    expect(retried).toMatch(/only the corrected JSON/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- promptBuilder.test`
Expected: FAIL — `Cannot find module '@/server/compiler/promptBuilder'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/server/compiler/promptBuilder.ts

export function buildCompilerPrompt(promptText: string, catalog: unknown[], structures: unknown[]): { system: string; user: string } {
  const structureNames = (structures as any[]).map((s) => s.structure);
  const system = `You turn a trader's plain-English screening prompt into a structured JSON spec. You read ONLY what the catalog below can compute, and you NEVER invent, default or guess a numeric value.

CATALOG (the only fields/indicators/ops you may use):
${JSON.stringify(catalog)}

STRUCTURES (choose exactly one, or null if the prompt doesn't make it clear):
${JSON.stringify(structureNames)}
- "literal": a weekly closing-price signal, checked once on the completed Friday bar.
- "t1_literal": something that can happen DURING the week, or over a rolling multi-day window.

RULES (do not violate any of these):
1. Never invent, default, or suggest a numeric value. Every number you place anywhere in the output (a condition's params, a condition's value, risk_cap_pct, near_miss.max_failed, selection_point.session_of_week, t1_window.length_sessions, t1_window.offsets) MUST have a matching entry in "source_phrases", keyed by its exact dotted path (e.g. "conditions.0.params.length", "risk_cap_pct", "t1_window.offsets.0").
2. If a condition names something not in the catalog, put the exact text in "unsupported" with a short reason, and do NOT include it in "conditions".
3. If a condition is named but is missing one of the catalog's required params, still include the condition in "conditions" (with that key simply absent from "params"), and add a "needs_input" item with "path" pointing at the exact missing value and a plain, neutral question — NEVER suggest or imply a value in the question text.
4. NEVER ask about liquidity in "needs_input" under any circumstance — the app always asks that itself, separately, outside this compiler.
5. Respond with ONLY one JSON object, no prose before or after it, matching exactly this shape:
{"structure": "literal"|"t1_literal"|null, "conditions": [{"id": "C1", "role": "filter"|"event"|"stop", "kind": "field"|"indicator", "name": "...", "params": {}, "op": "...", "value": null, "dir": null}], "selection_point": {"session_of_week": 1-5, "at": "open"|"close"}|null, "stop": {"from": "<condition id>"}|null, "risk_cap_pct": number|null, "near_miss": {"max_failed": number}|null, "t1_window": {"length_sessions": number, "offsets": [number]}|null, "source_phrases": [{"path": "...", "phrase": "..."}], "needs_input": [{"path": "...", "question": "..."}], "unsupported": [{"text": "...", "reason": "..."}]}`;

  const user = `Prompt:\n"""\n${promptText}\n"""`;
  return { system, user };
}

export function buildRetryUser(user: string, errors: string[]): string {
  return `${user}\n\nYour previous answer had these problems — fix every one of them and respond again with only the corrected JSON object, no other text:\n${errors.map((e) => `- ${e}`).join("\n")}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w apps/web -- promptBuilder.test`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/src/server/compiler/promptBuilder.ts frontend/apps/web/tests/promptBuilder.test.ts
git commit -m "feat(web): compiler prompt builder — catalog/structures embedding, no-invented-values and liquidity rules"
```

---

### Task 5: `compiler/callModel.ts` — the real `@anthropic-ai/sdk` wrapper

**Files:**
- Create: `apps/web/src/server/compiler/callModel.ts`
- Modify: `apps/web/package.json` (add `@anthropic-ai/sdk`)
- Test: `apps/web/tests/callModel.test.ts`

**Interfaces:**
- Produces: `DEFAULT_COMPILER_MODEL` (`"claude-sonnet-5"` unless `process.env.ANTHROPIC_COMPILER_MODEL` is set); `callClaude(system: string, user: string): Promise<string>` — throws a clear error if `ANTHROPIC_API_KEY` is unset, otherwise calls `@anthropic-ai/sdk`'s `messages.create` and returns the first text block. This is the only place in the whole plan that imports `@anthropic-ai/sdk` directly; every other module takes `callModel` as an injected function and never imports the SDK.

- [ ] **Step 1: Add the dependency**

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "0.32.1"
  }
}
```

(Merge into the existing `dependencies` block from Phases 1–2 — do not remove any existing entry.) Run (from `frontend/`): `npm install`.

- [ ] **Step 2: Write the failing test**

```ts
// apps/web/tests/callModel.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

describe("callClaude", () => {
  const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;
  afterEach(() => { process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY; });

  it("throws a clear error when ANTHROPIC_API_KEY is unset", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { callClaude } = await import("@/server/compiler/callModel");
    await expect(callClaude("system", "user")).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it("calls messages.create with the system/user and returns the first text block", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: vi.fn().mockImplementation(() => ({
        messages: { create: vi.fn().mockResolvedValue({ content: [{ type: "text", text: '{"ok":true}' }] }) },
      })),
    }));
    const { callClaude } = await import("@/server/compiler/callModel");
    const result = await callClaude("system prompt", "user prompt");
    expect(result).toBe('{"ok":true}');
    vi.doUnmock("@anthropic-ai/sdk");
  });
});
```

- [ ] **Step 2b: Run test to verify it fails**

Run: `npm run test -w apps/web -- callModel.test`
Expected: FAIL — `Cannot find module '@/server/compiler/callModel'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/server/compiler/callModel.ts
import Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_COMPILER_MODEL = process.env.ANTHROPIC_COMPILER_MODEL ?? "claude-sonnet-5";

export async function callClaude(system: string, user: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set — the prompt compiler needs it to call Claude");

  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model: DEFAULT_COMPILER_MODEL,
    max_tokens: 4096,
    system,
    messages: [{ role: "user", content: user }],
  });

  const block = message.content[0];
  if (!block || block.type !== "text") throw new Error("compiler model returned a non-text response");
  return block.text;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w apps/web -- callModel.test`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/package.json frontend/apps/web/src/server/compiler/callModel.ts frontend/apps/web/tests/callModel.test.ts frontend/package-lock.json
git commit -m "feat(web): callClaude — the only module that touches @anthropic-ai/sdk directly"
```

---

### Task 6: `compiler/compile.ts` — `compilePrompt`, retry-once, `CompileError`

**Files:**
- Create: `apps/web/src/server/compiler/compile.ts`
- Test: `apps/web/tests/compile.test.ts`

**Interfaces:**
- Consumes: `buildCompilerPrompt`/`buildRetryUser` (Task 4), `assertTraceable`/`UntraceableValueError` (Task 3), `CompileOutputSchema` (Task 1), `callClaude` (Task 5, as the default `callModel`).
- Produces: `CompileError` (has `.errors: string[]`); `compilePrompt(promptText: string, catalog: unknown[], structures: unknown[], opts?: { callModel?: (system: string, user: string) => Promise<string> }): Promise<{ output: CompileOutput; raw: string; attempts: number }>`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/compile.test.ts
import { describe, expect, it, vi } from "vitest";
import { compilePrompt, CompileError } from "@/server/compiler/compile";

const CATALOG = [
  { kind: "field", name: "mcap_cr", required_params: [], ops: [{ op: "between", requires_value: true }] },
  { kind: "indicator", name: "vstop", required_params: [{ name: "length" }, { name: "mult" }, { name: "source" }], ops: [{ op: "flip", requires_value: false }] },
];
const STRUCTURES = [{ structure: "literal" }, { structure: "t1_literal" }];

function fullyTraceableOutput() {
  return {
    structure: "literal",
    conditions: [{ id: "C1", role: "event", kind: "indicator", name: "vstop", params: { length: 10, mult: 2, source: "close" }, op: "flip", dir: "long" }],
    selection_point: null, stop: { from: "C1" }, risk_cap_pct: null, near_miss: null, t1_window: null,
    source_phrases: [{ path: "conditions.0.params.length", phrase: "VStop 10" }, { path: "conditions.0.params.mult", phrase: "mult 2" }],
    needs_input: [], unsupported: [],
  };
}

describe("compilePrompt", () => {
  it("succeeds on the first attempt when the model's output is fully valid and traceable", async () => {
    const callModel = vi.fn().mockResolvedValue(JSON.stringify(fullyTraceableOutput()));
    const { output, attempts } = await compilePrompt("VStop(10,2,close) flip up", CATALOG, STRUCTURES, { callModel });
    expect(attempts).toBe(1);
    expect(output.structure).toBe("literal");
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it("retries once with the errors when the first response has an untraceable number, then succeeds", async () => {
    const badOutput = { ...fullyTraceableOutput(), source_phrases: [] }; // length/mult now untraceable
    const callModel = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(badOutput))
      .mockResolvedValueOnce(JSON.stringify(fullyTraceableOutput()));
    const { attempts } = await compilePrompt("VStop(10,2,close) flip up", CATALOG, STRUCTURES, { callModel });
    expect(attempts).toBe(2);
    expect(callModel).toHaveBeenCalledTimes(2);
    const secondCallUser = callModel.mock.calls[1][1];
    expect(secondCallUser).toMatch(/no source phrase/);
  });

  it("throws CompileError after a second consecutive failure, never a third attempt", async () => {
    const callModel = vi.fn().mockResolvedValue("not json at all");
    await expect(compilePrompt("x", CATALOG, STRUCTURES, { callModel })).rejects.toBeInstanceOf(CompileError);
    expect(callModel).toHaveBeenCalledTimes(2);
  });

  it("rejects a condition naming something outside the catalog as a validation error, not a crash", async () => {
    const withUnknown = {
      ...fullyTraceableOutput(),
      conditions: [...fullyTraceableOutput().conditions, { id: "C2", role: "filter", kind: "indicator", name: "macd", params: {}, op: ">", value: 0 }],
    };
    const callModel = vi.fn().mockResolvedValue(JSON.stringify(withUnknown));
    await expect(compilePrompt("x", CATALOG, STRUCTURES, { callModel })).rejects.toBeInstanceOf(CompileError);
  });

  it("rejects a needs_input item that asks about liquidity", async () => {
    const withLiquidityQuestion = { ...fullyTraceableOutput(), needs_input: [{ path: "conditions.0.params.length", question: "What liquidity floor?" }] };
    const callModel = vi.fn().mockResolvedValue(JSON.stringify(withLiquidityQuestion));
    await expect(compilePrompt("x", CATALOG, STRUCTURES, { callModel })).rejects.toBeInstanceOf(CompileError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- compile.test`
Expected: FAIL — `Cannot find module '@/server/compiler/compile'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/server/compiler/compile.ts
import { CompileOutputSchema, type CompileOutput } from "spec";
import { buildCompilerPrompt, buildRetryUser } from "@/server/compiler/promptBuilder";
import { assertTraceable, UntraceableValueError } from "@/server/compiler/traceability";
import { callClaude } from "@/server/compiler/callModel";

export class CompileError extends Error {
  errors: string[];
  constructor(errors: string[]) {
    super(`compile failed after retrying once: ${errors.join("; ")}`);
    this.errors = errors;
  }
}

type CatalogEntry = { kind: string; name: string; required_params?: { name: string }[] };

function validateAgainstCatalog(output: CompileOutput, catalog: CatalogEntry[]): string[] {
  const errors: string[] = [];
  const byKey = new Map(catalog.map((c) => [`${c.kind}:${c.name}`, c]));

  output.conditions.forEach((cond, i) => {
    const entry = byKey.get(`${cond.kind}:${cond.name}`);
    if (!entry) {
      errors.push(`conditions.${i}: "${cond.kind}:${cond.name}" is not in the catalog — it must go into "unsupported" instead`);
      return;
    }
    for (const p of entry.required_params ?? []) {
      const present = (cond.params ?? {})[p.name] !== undefined;
      const flagged = output.needs_input.some((n) => n.path === `conditions.${i}.params.${p.name}`);
      if (!present && !flagged) errors.push(`conditions.${i}.params.${p.name}: required by the catalog, but neither present nor flagged in needs_input`);
    }
  });

  if (output.needs_input.some((n) => /liquidity/i.test(n.question))) {
    errors.push('needs_input must never ask about liquidity — the app always asks that separately, remove that item');
  }

  return errors;
}

type CallModelFn = (system: string, user: string) => Promise<string>;

export async function compilePrompt(
  promptText: string,
  catalog: CatalogEntry[],
  structures: unknown[],
  { callModel = callClaude }: { callModel?: CallModelFn } = {}
): Promise<{ output: CompileOutput; raw: string; attempts: number }> {
  const { system, user } = buildCompilerPrompt(promptText, catalog, structures);
  let lastErrors: string[] = [];
  let lastRaw = "";

  for (let attempt = 1; attempt <= 2; attempt++) {
    const userForThisAttempt = attempt === 1 ? user : buildRetryUser(user, lastErrors);
    lastRaw = await callModel(system, userForThisAttempt);

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(lastRaw);
    } catch {
      lastErrors = ["response was not valid JSON"];
      continue;
    }

    const parsed = CompileOutputSchema.safeParse(parsedJson);
    if (!parsed.success) {
      lastErrors = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
      continue;
    }

    const catalogErrors = validateAgainstCatalog(parsed.data, catalog);
    if (catalogErrors.length > 0) {
      lastErrors = catalogErrors;
      continue;
    }

    try {
      assertTraceable(parsed.data, parsed.data.source_phrases);
    } catch (err) {
      if (err instanceof UntraceableValueError) {
        lastErrors = err.paths.map((p) => `${p}: no source phrase for this number — never invent a value, add it to source_phrases or drop it`);
        continue;
      }
      throw err;
    }

    return { output: parsed.data, raw: lastRaw, attempts: attempt };
  }

  throw new CompileError(lastErrors);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w apps/web -- compile.test`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/src/server/compiler/compile.ts frontend/apps/web/tests/compile.test.ts
git commit -m "feat(web): compilePrompt — zod + catalog + traceability validation, exactly one retry, CompileError on persistent failure"
```

---

### Task 7: `compileDraft.ts` service + `POST /api/drafts/:draftId/compile`

**Files:**
- Create: `apps/web/src/server/compileDraft.ts`, `apps/web/app/api/drafts/[draftId]/compile/route.ts`
- Test: `apps/web/tests/compileDraft.test.ts`

**Interfaces:**
- Consumes: `getConditions`/`getStructures` (Phase 1 engine client), `compilePrompt`/`CompileError` (Task 6), `getDraft`/`updateDraft` (Task 2).
- Produces: `compileDraft(raw: Database.Database, draftId: number, opts?: { fetchFn?: typeof fetch; callModel?: Parameters<typeof compilePrompt>[3] extends { callModel?: infer F } ? F : never }): Promise<DraftRow>` — on success, writes `structure`/`specJson`/`needsInputJson`/`sourcePhrasesJson`/`unsupportedJson` onto the draft (when `output.structure` is `null`, it writes only `needsInputJson` — with a structure-choice question appended — and `sourcePhrasesJson`, leaving `structure`/`specJson` untouched) and logs a `compilations` row; on a `CompileError`, logs a `compilations` row with `errors_json` and rethrows, writing nothing to the draft's own columns.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/compileDraft.test.ts
import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { createDraft, updateDraft, getDraft } from "@/server/drafts";
import { compileDraft } from "@/server/compileDraft";
import { CompileError } from "@/server/compiler/compile";

function draftWithText(raw: ReturnType<typeof createTestDb>, text: string) {
  const userId = ensureOwnerUser(raw);
  const { draftId } = createDraft(raw, { userId });
  updateDraft(raw, draftId, { promptText: text });
  return draftId;
}

function fakeEngineFetch() {
  return vi.fn().mockImplementation(async (url: string) => {
    if (url.endsWith("/conditions")) return { ok: true, text: async () => JSON.stringify([{ kind: "indicator", name: "vstop", required_params: [{ name: "length" }, { name: "mult" }, { name: "source" }] }]) };
    if (url.endsWith("/structures")) return { ok: true, text: async () => JSON.stringify([{ structure: "literal" }, { structure: "t1_literal" }]) };
    throw new Error(`unexpected url ${url}`);
  });
}

describe("compileDraft", () => {
  it("on success, writes structure/specJson/sourcePhrases onto the draft and logs a compilations row", async () => {
    const raw = createTestDb();
    const draftId = draftWithText(raw, "VStop(10,2,close) flip up");
    const callModel = vi.fn().mockResolvedValue(JSON.stringify({
      structure: "literal",
      conditions: [{ id: "C1", role: "event", kind: "indicator", name: "vstop", params: { length: 10, mult: 2, source: "close" }, op: "flip", dir: "long" }],
      selection_point: null, stop: { from: "C1" }, risk_cap_pct: null, near_miss: null, t1_window: null,
      source_phrases: [{ path: "conditions.0.params.length", phrase: "10" }, { path: "conditions.0.params.mult", phrase: "2" }],
      needs_input: [], unsupported: [],
    }));

    const draft = await compileDraft(raw, draftId, { fetchFn: fakeEngineFetch() as any, callModel });
    expect(draft.structure).toBe("literal");
    expect(draft.spec?.conditions).toHaveLength(1);
    expect(draft.sourcePhrases).toHaveLength(2);

    const compilation = raw.prepare("SELECT model, errors_json FROM compilations WHERE draft_id = ?").get(draftId) as any;
    expect(compilation.model).toBeTruthy();
    expect(compilation.errors_json).toBeNull();
  });

  it("when structure is null, writes only needs_input (plus a structure question) and leaves specJson untouched", async () => {
    const raw = createTestDb();
    const draftId = draftWithText(raw, "something vague");
    const callModel = vi.fn().mockResolvedValue(JSON.stringify({
      structure: null, conditions: [], selection_point: null, stop: null, risk_cap_pct: null, near_miss: null, t1_window: null,
      source_phrases: [], needs_input: [], unsupported: [],
    }));

    const draft = await compileDraft(raw, draftId, { fetchFn: fakeEngineFetch() as any, callModel });
    expect(draft.spec).toBeNull();
    expect(draft.needsInput!.some((n) => n.path === "structure")).toBe(true);
  });

  it("on CompileError, writes nothing to the draft's structure/specJson and logs errors_json", async () => {
    const raw = createTestDb();
    const draftId = draftWithText(raw, "x");
    const callModel = vi.fn().mockResolvedValue("not json");

    await expect(compileDraft(raw, draftId, { fetchFn: fakeEngineFetch() as any, callModel })).rejects.toBeInstanceOf(CompileError);
    const draft = getDraft(raw, draftId)!;
    expect(draft.structure).toBeNull();
    expect(draft.spec).toBeNull();
    const compilation = raw.prepare("SELECT errors_json FROM compilations WHERE draft_id = ?").get(draftId) as any;
    expect(JSON.parse(compilation.errors_json)).toEqual(expect.arrayContaining(["response was not valid JSON"]));
  });

  it("throws when the draft has no prompt text yet", async () => {
    const raw = createTestDb();
    const userId = ensureOwnerUser(raw);
    const { draftId } = createDraft(raw, { userId });
    await expect(compileDraft(raw, draftId, { fetchFn: fakeEngineFetch() as any, callModel: vi.fn() })).rejects.toThrow(/no prompt text/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- compileDraft.test`
Expected: FAIL — `Cannot find module '@/server/compileDraft'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/server/compileDraft.ts
import type Database from "better-sqlite3";
import { getConditions, getStructures } from "@/server/engine/client";
import { compilePrompt, CompileError } from "@/server/compiler/compile";
import { DEFAULT_COMPILER_MODEL } from "@/server/compiler/callModel";
import { getDraft, updateDraft, type DraftRow } from "@/server/drafts";

type CompileModelFn = Parameters<typeof compilePrompt>[3] extends { callModel?: infer F } ? F : never;

export async function compileDraft(
  raw: Database.Database,
  draftId: number,
  { fetchFn, callModel }: { fetchFn?: typeof fetch; callModel?: CompileModelFn } = {}
): Promise<DraftRow> {
  const draft = getDraft(raw, draftId);
  if (!draft) throw new Error(`draft ${draftId} not found`);
  if (!draft.promptText.trim()) throw new Error("draft has no prompt text yet");

  const [catalog, structures] = await Promise.all([getConditions(fetchFn) as Promise<any[]>, getStructures(fetchFn) as Promise<any[]>]);
  const now = new Date().toISOString();

  try {
    const { output, raw: rawText } = await compilePrompt(draft.promptText, catalog, structures, { callModel });
    raw.prepare(`INSERT INTO compilations (draft_id, model, raw_json, created_at) VALUES (?, ?, ?, ?)`)
      .run(draftId, DEFAULT_COMPILER_MODEL, JSON.stringify({ text: rawText }), now);

    if (output.structure === null) {
      const needsInput = [
        ...output.needs_input,
        { path: "structure", question: "Is this a weekly closing-price signal (literal), or does it look for something happening during the week or over a rolling window (t1_literal)?" },
      ];
      updateDraft(raw, draftId, {
        needsInputJson: JSON.stringify(needsInput),
        sourcePhrasesJson: JSON.stringify(output.source_phrases),
        unsupportedJson: JSON.stringify(output.unsupported),
      });
    } else {
      const spec = {
        spec_version: 4, structure: output.structure, timeframe: "1W" as const,
        selection_point: output.selection_point, conditions: output.conditions, stop: output.stop,
        risk_cap_pct: output.risk_cap_pct, near_miss: output.near_miss, t1_window: output.t1_window,
      };
      updateDraft(raw, draftId, {
        structure: output.structure,
        specJson: JSON.stringify(spec),
        needsInputJson: JSON.stringify(output.needs_input),
        sourcePhrasesJson: JSON.stringify(output.source_phrases),
        unsupportedJson: JSON.stringify(output.unsupported),
      });
    }
  } catch (err) {
    if (err instanceof CompileError) {
      raw.prepare(`INSERT INTO compilations (draft_id, model, raw_json, errors_json, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(draftId, DEFAULT_COMPILER_MODEL, JSON.stringify({ text: null }), JSON.stringify(err.errors), now);
    }
    throw err;
  }

  return getDraft(raw, draftId)!;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w apps/web -- compileDraft.test`
Expected: PASS (4 tests)

- [ ] **Step 5: Write the route**

```ts
// apps/web/app/api/drafts/[draftId]/compile/route.ts
import { db } from "@/server/db/client";
import { compileDraft } from "@/server/compileDraft";
import { CompileError } from "@/server/compiler/compile";

export async function POST(_req: Request, { params }: { params: { draftId: string } }) {
  try {
    const draft = await compileDraft(db(), Number(params.draftId));
    return Response.json({
      structure: draft.structure, spec: draft.spec, needs_input: draft.needsInput,
      source_phrases: draft.sourcePhrases, unsupported: draft.unsupported,
    });
  } catch (err) {
    if (err instanceof CompileError) return Response.json({ errors: err.errors }, { status: 422 });
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add frontend/apps/web/src/server/compileDraft.ts frontend/apps/web/app/api/drafts/\[draftId\]/compile frontend/apps/web/tests/compileDraft.test.ts
git commit -m "feat(web): compileDraft service + POST /api/drafts/:draftId/compile"
```

---

### Task 8: `mergeAnswer.ts` — answering a `needs_input` question

**Files:**
- Create: `apps/web/src/server/mergeAnswer.ts`, `apps/web/app/api/drafts/[draftId]/answers/route.ts`
- Test: `apps/web/tests/mergeAnswer.test.ts`

**Interfaces:**
- Produces: `applyAnswer(raw: Database.Database, draftId: number, { path, value }: { path: string; value: number | string }): DraftRow` — writes the value at `path` into the draft's `spec_json` (creating `conditions[i].params[key]` or `conditions[i].value` etc. as needed), removes the matching item from `needs_input_json`, and appends `{ path, value }` to a running `answers_json` array (already an existing column from Phase 1, previously unused) so a later confirm can tell this value apart from a model-sourced one. Throws if `path` doesn't match any current `needs_input` item (prevents answering something nobody asked, and prevents double-answering silently diverging from what's shown).

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/mergeAnswer.test.ts
import { describe, expect, it } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { createDraft, updateDraft, getDraft } from "@/server/drafts";
import { applyAnswer } from "@/server/mergeAnswer";

function compiledDraftMissingLength(raw: ReturnType<typeof createTestDb>) {
  const userId = ensureOwnerUser(raw);
  const { draftId } = createDraft(raw, { userId });
  const spec = {
    spec_version: 4, structure: "literal" as const, timeframe: "1W" as const, selection_point: null,
    conditions: [{ id: "C1", role: "event" as const, kind: "indicator" as const, name: "vstop", params: { mult: 2, source: "close" }, op: "flip", dir: "long" as const }],
    stop: { from: "C1" }, risk_cap_pct: null, near_miss: null,
  };
  updateDraft(raw, draftId, {
    structure: "literal", specJson: JSON.stringify(spec),
    needsInputJson: JSON.stringify([{ path: "conditions.0.params.length", question: "What VStop length?" }]),
  });
  return draftId;
}

describe("applyAnswer", () => {
  it("writes the answered value into spec_json at the given path and removes the needs_input item", () => {
    const raw = createTestDb();
    const draftId = compiledDraftMissingLength(raw);
    const draft = applyAnswer(raw, draftId, { path: "conditions.0.params.length", value: 10 });
    expect(draft.spec!.conditions[0].params.length).toBe(10);
    expect(draft.needsInput).toEqual([]);
  });

  it("records the answer so it can be told apart from a model-sourced value later", () => {
    const raw = createTestDb();
    const draftId = compiledDraftMissingLength(raw);
    applyAnswer(raw, draftId, { path: "conditions.0.params.length", value: 10 });
    const row = raw.prepare("SELECT answers_json FROM prompt_drafts WHERE draft_id = ?").get(draftId) as any;
    expect(JSON.parse(row.answers_json)).toEqual([{ path: "conditions.0.params.length", value: 10 }]);
  });

  it("rejects a path nobody asked about", () => {
    const raw = createTestDb();
    const draftId = compiledDraftMissingLength(raw);
    expect(() => applyAnswer(raw, draftId, { path: "risk_cap_pct", value: 15 })).toThrow(/not a current needs_input item/);
  });

  it("can fill a top-level path like selection_point.session_of_week by creating the object", () => {
    const raw = createTestDb();
    const userId = ensureOwnerUser(raw);
    const { draftId } = createDraft(raw, { userId });
    const spec = {
      spec_version: 4, structure: "literal" as const, timeframe: "1W" as const, selection_point: null,
      conditions: [], stop: null, risk_cap_pct: null, near_miss: null,
    };
    updateDraft(raw, draftId, { structure: "literal", specJson: JSON.stringify(spec), needsInputJson: JSON.stringify([{ path: "selection_point.session_of_week", question: "Which session of the week?" }]) });
    const draft = applyAnswer(raw, draftId, { path: "selection_point.session_of_week", value: 1 });
    expect(draft.spec!.selection_point).toEqual({ session_of_week: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- mergeAnswer.test`
Expected: FAIL — `Cannot find module '@/server/mergeAnswer'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/server/mergeAnswer.ts
import type Database from "better-sqlite3";
import { getDraft, updateDraft, type DraftRow } from "@/server/drafts";

function setAtPath(obj: any, path: string, value: unknown): void {
  const keys = path.split(".");
  let node = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (node[key] === undefined || node[key] === null) node[key] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    node = node[key];
  }
  node[keys[keys.length - 1]] = value;
}

export function applyAnswer(
  raw: Database.Database,
  draftId: number,
  { path, value }: { path: string; value: number | string }
): DraftRow {
  const draft = getDraft(raw, draftId);
  if (!draft) throw new Error(`draft ${draftId} not found`);
  if (!draft.spec) throw new Error("draft has no spec yet — compile or build it first");

  const needsInput = draft.needsInput ?? [];
  if (!needsInput.some((n) => n.path === path)) {
    throw new Error(`"${path}" is not a current needs_input item for draft ${draftId}`);
  }

  const spec = JSON.parse(JSON.stringify(draft.spec));
  setAtPath(spec, path, value);

  const remainingNeedsInput = needsInput.filter((n) => n.path !== path);
  const answers = (JSON.parse(raw.prepare("SELECT answers_json FROM prompt_drafts WHERE draft_id = ?").get(draftId)!.answers_json ?? "[]") as { path: string; value: unknown }[])
    .filter((a) => a.path !== path)
    .concat([{ path, value }]);

  return updateDraft(raw, draftId, {
    specJson: JSON.stringify(spec),
    needsInputJson: JSON.stringify(remainingNeedsInput),
  });
  // Note: updateDraft's DraftPatch doesn't carry answersJson as a settable
  // field in its public type (Task 2's DraftPatch omits it on purpose — only
  // this module ever writes answers_json, directly, to keep "what counts as
  // an answer" in one place) — write it with its own statement instead:
}
```

Wait — `updateDraft` is called before the `answers_json` write above, which is backwards (the comment is dangling and the raw SQL write never happens). Correct ordering:

```ts
// apps/web/src/server/mergeAnswer.ts (corrected)
import type Database from "better-sqlite3";
import { getDraft, updateDraft, type DraftRow } from "@/server/drafts";

function setAtPath(obj: any, path: string, value: unknown): void {
  const keys = path.split(".");
  let node = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (node[key] === undefined || node[key] === null) node[key] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    node = node[key];
  }
  node[keys[keys.length - 1]] = value;
}

export function applyAnswer(
  raw: Database.Database,
  draftId: number,
  { path, value }: { path: string; value: number | string }
): DraftRow {
  const draft = getDraft(raw, draftId);
  if (!draft) throw new Error(`draft ${draftId} not found`);
  if (!draft.spec) throw new Error("draft has no spec yet — compile or build it first");

  const needsInput = draft.needsInput ?? [];
  if (!needsInput.some((n) => n.path === path)) {
    throw new Error(`"${path}" is not a current needs_input item for draft ${draftId}`);
  }

  const spec = JSON.parse(JSON.stringify(draft.spec));
  setAtPath(spec, path, value);
  const remainingNeedsInput = needsInput.filter((n) => n.path !== path);

  const existingAnswersRow = raw.prepare("SELECT answers_json FROM prompt_drafts WHERE draft_id = ?").get(draftId) as { answers_json: string | null };
  const answers = (existingAnswersRow.answers_json ? JSON.parse(existingAnswersRow.answers_json) : []) as { path: string; value: unknown }[];
  const nextAnswers = answers.filter((a) => a.path !== path).concat([{ path, value }]);
  raw.prepare("UPDATE prompt_drafts SET answers_json = ? WHERE draft_id = ?").run(JSON.stringify(nextAnswers), draftId);

  return updateDraft(raw, draftId, { specJson: JSON.stringify(spec), needsInputJson: JSON.stringify(remainingNeedsInput) });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w apps/web -- mergeAnswer.test`
Expected: PASS (4 tests)

- [ ] **Step 5: Write the route**

```ts
// apps/web/app/api/drafts/[draftId]/answers/route.ts
import { db } from "@/server/db/client";
import { applyAnswer } from "@/server/mergeAnswer";

export async function POST(req: Request, { params }: { params: { draftId: string } }) {
  const { path, value } = await req.json();
  try {
    const draft = applyAnswer(db(), Number(params.draftId), { path, value });
    return Response.json({ spec: draft.spec, needs_input: draft.needsInput });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add frontend/apps/web/src/server/mergeAnswer.ts frontend/apps/web/app/api/drafts/\[draftId\]/answers frontend/apps/web/tests/mergeAnswer.test.ts
git commit -m "feat(web): applyAnswer — merges one needs_input answer into spec_json, records it in answers_json"
```

---

### Task 9: `confirm.ts` — confirm gate + per-condition `value_origin`/`source_phrase` for compiler-originated drafts

**Files:**
- Modify: `apps/web/src/server/confirm.ts`
- Test: `apps/web/tests/confirm-gate.test.ts`, `apps/web/tests/confirm-compiler-origin.test.ts`

**Interfaces:**
- Modifies `confirmDraft`'s pre-flight checks: adds `"needs_input not empty"` and `"unsupported conditions present"` to the existing `problems` array (checked alongside the Phase 1 `no spec`/`no structure`/`no hypothesis`/`no kill criterion` checks) whenever `draft.needsInput`/`draft.unsupported` is non-empty. Modifies the `prompt_conditions` insert loop: for each condition, origin is `'prompt'` only if every one of `numericLeafPaths` restricted to that single condition's own paths is present in `draft.sourcePhrases`; otherwise `'user_answer'`. `source_phrase` is set to the joined matching phrases (origin `'prompt'`) or the joined matching answer values from `answers_json` (origin `'user_answer'` via the compiler path) or `NULL` (manual-form path, unchanged from Phase 1/2).

- [ ] **Step 1: Write the failing confirm-gate tests**

```ts
// apps/web/tests/confirm-gate.test.ts
import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { createDraft, updateDraft } from "@/server/drafts";
import { confirmDraft } from "@/server/confirm";

const SPEC = {
  spec_version: 4, structure: "literal" as const, timeframe: "1W" as const, selection_point: null,
  conditions: [{ id: "C1", role: "filter" as const, kind: "field" as const, name: "mcap_cr", params: {}, op: "between", value: [10000, 50000] }],
  stop: null, risk_cap_pct: null, near_miss: null,
};

function compiledDraft(raw: ReturnType<typeof createTestDb>, overrides: Record<string, unknown>) {
  const userId = ensureOwnerUser(raw);
  const { draftId } = createDraft(raw, { userId });
  updateDraft(raw, draftId, {
    structure: "literal", specJson: JSON.stringify(SPEC), hypothesis: "h", killCriterion: "k",
    needsInputJson: "[]", sourcePhrasesJson: "[]", unsupportedJson: "[]",
    ...overrides,
  });
  return draftId;
}

describe("confirmDraft — compiler confirm gate", () => {
  it("blocks confirm while needs_input is non-empty", async () => {
    const raw = createTestDb();
    const draftId = compiledDraft(raw, { needsInputJson: JSON.stringify([{ path: "conditions.0.params.length", question: "What length?" }]) });
    await expect(confirmDraft(raw, draftId, "2026-10-02", vi.fn() as any)).rejects.toThrow(/needs_input/);
  });

  it("blocks confirm while an unsupported condition is still present", async () => {
    const raw = createTestDb();
    const draftId = compiledDraft(raw, { unsupportedJson: JSON.stringify([{ text: "MACD crossover", reason: "not in catalog" }]) });
    await expect(confirmDraft(raw, draftId, "2026-10-02", vi.fn() as any)).rejects.toThrow(/unsupported/);
  });

  it("confirms normally once needs_input and unsupported are both empty", async () => {
    const raw = createTestDb();
    const draftId = compiledDraft(raw, {});
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ candidates: [], applied_steps: [], funnel: [], sector_view: [] }) });
    const { promptId } = await confirmDraft(raw, draftId, "2026-10-02", fetchFn as any);
    expect(promptId).toBeGreaterThan(0);
  });
});
```

```ts
// apps/web/tests/confirm-compiler-origin.test.ts
import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { createDraft, updateDraft } from "@/server/drafts";
import { confirmDraft } from "@/server/confirm";

describe("confirmDraft — value_origin from the compiler path", () => {
  it("marks a condition 'prompt' origin when every one of its numeric leaves has a source phrase", async () => {
    const raw = createTestDb();
    const userId = ensureOwnerUser(raw);
    const { draftId } = createDraft(raw, { userId });
    const spec = {
      spec_version: 4, structure: "literal" as const, timeframe: "1W" as const, selection_point: null,
      conditions: [{ id: "C1", role: "event" as const, kind: "indicator" as const, name: "vstop", params: { length: 10, mult: 2, source: "close" }, op: "flip", dir: "long" as const }],
      stop: { from: "C1" }, risk_cap_pct: null, near_miss: null,
    };
    updateDraft(raw, draftId, {
      structure: "literal", specJson: JSON.stringify(spec), hypothesis: "h", killCriterion: "k",
      needsInputJson: "[]", unsupportedJson: "[]",
      sourcePhrasesJson: JSON.stringify([{ path: "conditions.0.params.length", phrase: "VStop 10" }, { path: "conditions.0.params.mult", phrase: "mult 2" }]),
    });
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ candidates: [], applied_steps: [], funnel: [], sector_view: [] }) });
    const { promptId } = await confirmDraft(raw, draftId, "2026-10-02", fetchFn as any);

    const row = raw.prepare("SELECT value_origin, source_phrase FROM prompt_conditions WHERE prompt_id = ? AND cond_no = 1").get(promptId) as any;
    expect(row.value_origin).toBe("prompt");
    expect(row.source_phrase).toContain("VStop 10");
  });

  it("marks a condition 'user_answer' origin when any one of its numeric leaves came from an answer, not a source phrase", async () => {
    const raw = createTestDb();
    const userId = ensureOwnerUser(raw);
    const { draftId } = createDraft(raw, { userId });
    const spec = {
      spec_version: 4, structure: "literal" as const, timeframe: "1W" as const, selection_point: null,
      conditions: [{ id: "C1", role: "event" as const, kind: "indicator" as const, name: "vstop", params: { length: 10, mult: 2, source: "close" }, op: "flip", dir: "long" as const }],
      stop: { from: "C1" }, risk_cap_pct: null, near_miss: null,
    };
    updateDraft(raw, draftId, {
      structure: "literal", specJson: JSON.stringify(spec), hypothesis: "h", killCriterion: "k",
      needsInputJson: "[]", unsupportedJson: "[]",
      sourcePhrasesJson: JSON.stringify([{ path: "conditions.0.params.mult", phrase: "mult 2" }]),
    });
    raw.prepare("UPDATE prompt_drafts SET answers_json = ? WHERE draft_id = ?").run(JSON.stringify([{ path: "conditions.0.params.length", value: 10 }]), draftId);
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ candidates: [], applied_steps: [], funnel: [], sector_view: [] }) });
    const { promptId } = await confirmDraft(raw, draftId, "2026-10-02", fetchFn as any);

    const row = raw.prepare("SELECT value_origin FROM prompt_conditions WHERE prompt_id = ? AND cond_no = 1").get(promptId) as any;
    expect(row.value_origin).toBe("user_answer");
  });

  it("manual-form drafts (no sourcePhrases/needsInput ever set) are unaffected — still always user_answer, source_phrase NULL", async () => {
    const raw = createTestDb();
    const userId = ensureOwnerUser(raw);
    const { draftId } = createDraft(raw, { userId });
    const spec = {
      spec_version: 4, structure: "literal" as const, timeframe: "1W" as const, selection_point: null,
      conditions: [{ id: "C1", role: "filter" as const, kind: "field" as const, name: "mcap_cr", params: {}, op: "between", value: [10000, 50000] }],
      stop: null, risk_cap_pct: null, near_miss: null,
    };
    updateDraft(raw, draftId, { structure: "literal", specJson: JSON.stringify(spec), hypothesis: "h", killCriterion: "k" });
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ candidates: [], applied_steps: [], funnel: [], sector_view: [] }) });
    const { promptId } = await confirmDraft(raw, draftId, "2026-10-02", fetchFn as any);

    const row = raw.prepare("SELECT value_origin, source_phrase FROM prompt_conditions WHERE prompt_id = ? AND cond_no = 1").get(promptId) as any;
    expect(row.value_origin).toBe("user_answer");
    expect(row.source_phrase).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -w apps/web -- confirm-gate.test confirm-compiler-origin.test`
Expected: FAIL — the gate/origin logic doesn't exist yet (every case currently behaves like Phase 1/2: no needs_input/unsupported check, always `'user_answer'`/`NULL`).

- [ ] **Step 3: Modify `confirm.ts`**

```ts
// apps/web/src/server/confirm.ts
import { numericLeafPaths } from "@/server/compiler/traceability";

// In confirmDraft, extend the existing `problems` block:
  const problems: string[] = [];
  if (!draft.spec) problems.push("no spec");
  if (!draft.structure) problems.push("no structure");
  if (!draft.hypothesis) problems.push("no hypothesis");
  if (!draft.killCriterion) problems.push("no kill criterion");
  if (draft.needsInput && draft.needsInput.length > 0) problems.push(`needs_input is not empty (${draft.needsInput.length} question(s) unanswered)`);
  if (draft.unsupported && draft.unsupported.length > 0) problems.push(`unsupported conditions are still present (${draft.unsupported.map((u) => u.text).join(", ")})`);
  if (problems.length > 0) throw new Error(`confirm blocked: ${problems.join(", ")}`);

// Replace the condition-insert loop's hardcoded 'user_answer' with the computed origin:
    const sourcePhrases = draft.sourcePhrases ?? [];
    const answers = (JSON.parse(
      (raw.prepare("SELECT answers_json FROM prompt_drafts WHERE draft_id = ?").get(draftId) as { answers_json: string | null }).answers_json ?? "[]"
    ) as { path: string }[]).map((a) => a.path);
    const knownPhrasePaths = new Set(sourcePhrases.map((s) => s.path));
    const knownAnswerPaths = new Set(answers);

    draft.spec!.conditions.forEach((cond, i) => {
      const thisConditionLeaves = numericLeafPaths({ conditions: [cond], risk_cap_pct: null, near_miss: null, selection_point: null, t1_window: null })
        .map((p) => p.replace(/^conditions\.0\./, `conditions.${i}.`));
      const allFromPrompt = thisConditionLeaves.length > 0 && thisConditionLeaves.every((p) => knownPhrasePaths.has(p));
      const anyFromAnswer = thisConditionLeaves.some((p) => knownAnswerPaths.has(p));

      let valueOrigin: "prompt" | "user_answer" = "user_answer";
      let sourcePhrase: string | null = null;
      if (allFromPrompt) {
        valueOrigin = "prompt";
        sourcePhrase = sourcePhrases.filter((s) => thisConditionLeaves.includes(s.path)).map((s) => s.phrase).join(" / ") || null;
      } else if (anyFromAnswer || thisConditionLeaves.length === 0) {
        // thisConditionLeaves.length === 0 covers both: a condition with no
        // numeric params at all (nothing to trace either way — Phase 1/2's
        // manual-form behavior, always user_answer/NULL), and a
        // compiler-sourced condition answered purely by the user.
        valueOrigin = "user_answer";
        sourcePhrase = null;
      }

      insertCondition.run(promptId, i + 1, cond.role, cond.kind, cond.name, JSON.stringify(cond.params ?? {}), cond.op, JSON.stringify(cond.value ?? null), valueOrigin, sourcePhrase);
    });
```

(The `insertCondition` prepared statement's SQL text changes from Phase 1's hardcoded `'user_answer'` literal to two bound parameters — update its text too: `INSERT INTO prompt_conditions (prompt_id, cond_no, role, kind, name, params_json, op, value_json, value_origin, source_phrase) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -w apps/web -- confirm-gate.test confirm-compiler-origin.test confirm.test confirm-versioning.test`
Expected: PASS. The third test case in `confirm-compiler-origin.test.ts` pins that Phase 1/2's existing manual-form behavior (`tests/confirm.test.ts`) is unaffected: a manual-form draft's `draft.sourcePhrases`/`draft.needsInput`/`draft.unsupported` are all `null` (never set by `updateDraft` outside the compiler path), so `thisConditionLeaves.length === 0` is false whenever a manual condition HAS numeric params (e.g. `mcap_cr`'s `value: [10000, 50000]`) — walk through this case specifically: `knownPhrasePaths`/`knownAnswerPaths` are both empty sets, so `allFromPrompt` is false and `anyFromAnswer` is false, falling to the `else` branch's final condition `thisConditionLeaves.length === 0` which is also false (mcap_cr has 2 numeric leaves) — re-read the branch: with neither `allFromPrompt` nor `anyFromAnswer` nor the empty-leaves case true, the code falls through without reassigning `valueOrigin`/`sourcePhrase` past their initial `"user_answer"`/`null` — confirm this is exactly what the third test expects before trusting the branch; if the full test run shows otherwise, fix the branch to make `"user_answer"` the explicit default in every case that isn't `allFromPrompt === true`, rather than relying on fallthrough.

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/src/server/confirm.ts frontend/apps/web/tests/confirm-gate.test.ts frontend/apps/web/tests/confirm-compiler-origin.test.ts
git commit -m "feat(web): confirm gate for needs_input/unsupported + per-condition value_origin/source_phrase from the compiler path"
```

---

### Task 10: Frontend — "Read my prompt" and "How your prompt was read"

**Files:**
- Modify: `apps/web/app/drafts/new/page.tsx`

**Interfaces:**
- Adds a prompt `<textarea>` + "Read my prompt" button above the existing manual structure/condition-row UI (which stays, unchanged, as the fallback/override path — frontend plan §3.2 describes them as one screen, not two separate modes). On click, calls `POST /api/drafts/:draftId/compile`, then renders: a summary line ("N conditions found · M questions"), the structure radio cards with which words decided it (from `source_phrases` with `path === "structure"`), and a "How your prompt was read" table (Role · Condition · Parameters · Your words) where a parameter with no matching `source_phrases` entry shows an amber `"?"` — never a defaults column, matching frontend plan §3.2 exactly.

- [ ] **Step 1: Extend the page's state and add the compile flow**

```tsx
// apps/web/app/drafts/new/page.tsx — add near the top, alongside the existing useState calls
  const [promptText, setPromptText] = useState("");
  const [compiling, setCompiling] = useState(false);
  const [compileResult, setCompileResult] = useState<{
    structure: "literal" | "t1_literal" | null;
    spec: ScreenSpec | null;
    needs_input: { path: string; question: string }[];
    source_phrases: { path: string; phrase: string }[];
    unsupported: { text: string; reason: string }[];
  } | null>(null);
  const [compileError, setCompileError] = useState<string | null>(null);

  async function readMyPrompt() {
    setCompiling(true);
    setCompileError(null);
    try {
      await fetch(`/api/drafts/${draftId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ promptText }) });
      const res = await fetch(`/api/drafts/${draftId}/compile`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        setCompileError(describeApiError(body, "could not read this prompt"));
        return;
      }
      setCompileResult(body);
      if (body.structure) setStructure(body.structure);
      if (body.spec?.conditions) setConditions(body.spec.conditions);
    } finally {
      setCompiling(false);
    }
  }

  function phraseFor(path: string): string | null {
    return compileResult?.source_phrases.find((p) => p.path === path)?.phrase ?? null;
  }
```

- [ ] **Step 2: Render the textarea, button, and the "how it was read" table**

```tsx
// apps/web/app/drafts/new/page.tsx — insert right after the "Draft N" heading, before the existing <label>Structure…
      <label>
        Your prompt
        <textarea aria-label="prompt text" value={promptText} onChange={(e) => setPromptText(e.target.value)} />
      </label>
      <button type="button" onClick={readMyPrompt} disabled={compiling || !promptText.trim()}>
        {compiling ? "Reading…" : "Read my prompt"}
      </button>
      {compileError && <p role="alert">{compileError}</p>}

      {compileResult && (
        <section>
          <p>
            {compileResult.spec?.conditions.length ?? 0} condition{(compileResult.spec?.conditions.length ?? 0) === 1 ? "" : "s"} found ·{" "}
            {compileResult.needs_input.length} question{compileResult.needs_input.length === 1 ? "" : "s"}
          </p>
          <p>
            Structure: <strong>{compileResult.structure ?? "unclear"}</strong>
            {phraseFor("structure") && <> — decided by "{phraseFor("structure")}"</>}
          </p>

          <h2>How your prompt was read</h2>
          <table>
            <thead><tr><th>Role</th><th>Condition</th><th>Parameters</th><th>Your words</th></tr></thead>
            <tbody>
              {(compileResult.spec?.conditions ?? []).map((c, i) => (
                <tr key={c.id}>
                  <td>{c.role}</td>
                  <td>{c.kind}:{c.name}</td>
                  <td>
                    {Object.keys(c.params ?? {}).length === 0 && !phraseFor(`conditions.${i}.params`) ? "—" : null}
                    {Object.entries(c.params ?? {}).map(([k, v]) => (
                      <span key={k}>{k}={String(v)} </span>
                    ))}
                    {/* A required param this condition is still missing shows as an amber "?", not silently as nothing */}
                    {compileResult.needs_input.filter((n) => n.path.startsWith(`conditions.${i}.params.`)).map((n) => (
                      <span key={n.path} style={{ color: "#b45f06" }} title={n.question}>?</span>
                    ))}
                  </td>
                  <td>{phraseFor(`conditions.${i}.params.${Object.keys(c.params ?? {})[0] ?? ""}`) ?? phraseFor(`conditions.${i}.value`) ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {compileResult.unsupported.length > 0 && (
            <div role="alert" style={{ border: "2px solid #c00", padding: "8px" }}>
              <strong>Unsupported conditions — remove these from your prompt and read it again:</strong>
              <ul>
                {compileResult.unsupported.map((u, i) => <li key={i}>"{u.text}" — {u.reason}</li>)}
              </ul>
            </div>
          )}
        </section>
      )}
```

- [ ] **Step 3: Build check and manual smoke test**

Run: `npm run build -w apps/web`
Expected: builds with no type errors.

Then, with `ANTHROPIC_API_KEY` set and the Python engine running: open `/drafts/new`, type a prompt describing the original brief in full, click "Read my prompt", and confirm the structure/conditions/questions table renders something plausible. This manual step needs a live Claude API key and cannot be made hermetic — it is the compiler's equivalent of Phase 1 Task 12's own live-engine smoke test, not a substitute for Task 6/7's automated tests.

- [ ] **Step 4: Commit**

```bash
git add frontend/apps/web/app/drafts/new/page.tsx
git commit -m "feat(web): New-prompt page — Read my prompt, how-it-was-read table, unsupported block"
```

---

### Task 11: Frontend — "Questions for you" + confirm gate wiring

**Files:**
- Modify: `apps/web/app/drafts/new/page.tsx`

**Interfaces:**
- Renders one input per `compileResult.needs_input` item, each with an **empty** input and **no suggested value** (frontend plan §3.2 — "no pre-filled value" even here), a "Save answer" button per question that calls `POST /api/drafts/:draftId/answers` and removes that question from the list on success. Extends the existing `gateReason()` function so Confirm stays disabled (with the right reason text) while any `needs_input` or `unsupported` item remains, mirroring Task 9's server-side gate exactly so the button's disabled state and the server's 400 message never disagree.

- [ ] **Step 1: Render the questions list with per-question answer inputs**

```tsx
// apps/web/app/drafts/new/page.tsx — inside the compileResult && (...) block, after the unsupported block
          {compileResult.needs_input.length > 0 && (
            <fieldset>
              <legend>Questions for you</legend>
              {compileResult.needs_input.map((n, i) => (
                <QuestionRow key={n.path} index={i + 1} item={n} draftId={draftId!} onAnswered={(path) => {
                  setCompileResult((prev) => (prev ? { ...prev, needs_input: prev.needs_input.filter((x) => x.path !== path) } : prev));
                  fetch(`/api/drafts/${draftId}`).then((r) => r.json()).then((d) => { if (d.spec?.conditions) setConditions(d.spec.conditions); });
                }} />
              ))}
            </fieldset>
          )}
```

- [ ] **Step 2: Write the `QuestionRow` helper component in the same file**

```tsx
// apps/web/app/drafts/new/page.tsx — add above the default export
function QuestionRow({ index, item, draftId, onAnswered }: { index: number; item: { path: string; question: string }; draftId: number; onAnswered: (path: string) => void }) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const numeric = Number(value);
      const res = await fetch(`/api/drafts/${draftId}/answers`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: item.path, value: Number.isNaN(numeric) ? value : numeric }),
      });
      const body = await res.json();
      if (!res.ok) { setError(body.error ?? "could not save answer"); return; }
      onAnswered(item.path);
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
      <button type="button" onClick={save} disabled={saving || value === ""}>Save answer</button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 3: Wire the confirm gate to `needs_input`/`unsupported`**

```tsx
// apps/web/app/drafts/new/page.tsx — extend the existing gateReason()
  function gateReason(): string | null {
    if (!structure) return "Choose a structure";
    if (conditions.length === 0) return "Add at least one condition";
    if (compileResult && compileResult.needs_input.length > 0) return `Answer ${compileResult.needs_input.length} question(s) first`;
    if (compileResult && compileResult.unsupported.length > 0) return "Remove the unsupported condition(s) from your prompt first";
    if (liquidity === null) return "Answer the liquidity question";
    if (liquidity === "custom" && (liquidityCustom === "" || Number.isNaN(Number(liquidityCustom)))) {
      return "Enter a valid liquidity floor";
    }
    if (!hypothesis) return "Add a hypothesis";
    if (!killCriterion) return "Add a kill criterion";
    return null;
  }
```

- [ ] **Step 4: Build check**

Run: `npm run build -w apps/web`
Expected: builds with no type errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/app/drafts/new/page.tsx
git commit -m "feat(web): Questions-for-you answer inputs + confirm gate wired to needs_input/unsupported"
```

---

### Task 12: Hermetic compiler regression suite

**Files:**
- Create: `apps/web/tests/compiler-regression.test.ts`

**Interfaces:**
- Consumes: `compilePrompt` (Task 6) with a fake `callModel` per case, mirroring the shape of backend plan §10's test table ("No app-supplied values", "Liquidity exception", "Open parameters", "Structure applicability") but scoped to what's testable without a live model (Global Constraints).

- [ ] **Step 1: Write the regression tests**

```ts
// apps/web/tests/compiler-regression.test.ts
import { describe, expect, it, vi } from "vitest";
import { compilePrompt, CompileError } from "@/server/compiler/compile";

const CATALOG = [
  { kind: "field", name: "mcap_cr", required_params: [], ops: [{ op: "between", requires_value: true }] },
  { kind: "field", name: "traded_value_cr", required_params: [{ name: "window" }], ops: [{ op: ">=", requires_value: true }] },
  { kind: "indicator", name: "vstop", required_params: [{ name: "length" }, { name: "mult" }, { name: "source" }], ops: [{ op: "flip", requires_value: false }] },
  { kind: "indicator", name: "rsi", required_params: [{ name: "length" }], ops: [{ op: "between", requires_value: true }] },
];
const STRUCTURES = [{ structure: "literal" }, { structure: "t1_literal" }];

function modelReturning(output: unknown) {
  return vi.fn().mockResolvedValue(JSON.stringify(output));
}

describe("compiler regression — no app-supplied values", () => {
  it("the full original brief, fully traceable, compiles in one attempt with the right structure", async () => {
    const callModel = modelReturning({
      structure: "literal",
      conditions: [
        { id: "C1", role: "filter", kind: "field", name: "mcap_cr", params: {}, op: "between", value: [10000, 50000] },
        { id: "C2", role: "filter", kind: "field", name: "traded_value_cr", params: { window: "1W" }, op: ">=", value: 10 },
        { id: "C3", role: "event", kind: "indicator", name: "vstop", params: { length: 10, mult: 2, source: "close" }, op: "flip", dir: "long" },
        { id: "C4", role: "filter", kind: "indicator", name: "rsi", params: { length: 14 }, op: "between", value: [50, 65] },
      ],
      selection_point: { session_of_week: 1, at: "open" }, stop: { from: "C3" }, risk_cap_pct: null, near_miss: null, t1_window: null,
      source_phrases: [
        { path: "conditions.0.value.0", phrase: "10,000cr" }, { path: "conditions.0.value.1", phrase: "50,000cr" },
        { path: "conditions.1.value", phrase: "10cr/week" },
        { path: "conditions.2.params.length", phrase: "VStop 10" }, { path: "conditions.2.params.mult", phrase: "multiplier 2" },
        { path: "conditions.3.params.length", phrase: "RSI 14" }, { path: "conditions.3.value.0", phrase: "between 50" }, { path: "conditions.3.value.1", phrase: "and 65" },
        { path: "selection_point.session_of_week", phrase: "Monday" },
      ],
      needs_input: [], unsupported: [],
    });
    const { output, attempts } = await compilePrompt("...", CATALOG, STRUCTURES, { callModel });
    expect(attempts).toBe(1);
    expect(output.structure).toBe("literal");
    expect(output.conditions).toHaveLength(4);
  });

  it("'VStop flip, no params given' never compiles with a guessed length/mult/source — it is flagged in needs_input instead", async () => {
    const callModel = modelReturning({
      structure: "literal",
      conditions: [{ id: "C1", role: "event", kind: "indicator", name: "vstop", params: {}, op: "flip", dir: "long" }],
      selection_point: null, stop: { from: "C1" }, risk_cap_pct: null, near_miss: null, t1_window: null,
      source_phrases: [],
      needs_input: [
        { path: "conditions.0.params.length", question: "What VStop length?" },
        { path: "conditions.0.params.mult", question: "What VStop multiplier?" },
        { path: "conditions.0.params.source", question: "What price source (open/high/low/close)?" },
      ],
      unsupported: [],
    });
    const { output } = await compilePrompt("VStop flip", CATALOG, STRUCTURES, { callModel });
    expect(output.conditions[0].params).toEqual({});
    expect(output.needs_input).toHaveLength(3);
  });
});

describe("compiler regression — liquidity exception", () => {
  it("a prompt that never mentions liquidity still never gets a liquidity needs_input item from the compiler", async () => {
    const callModel = modelReturning({
      structure: "literal", conditions: [], selection_point: null, stop: null, risk_cap_pct: null, near_miss: null, t1_window: null,
      source_phrases: [], needs_input: [], unsupported: [],
    });
    const { output } = await compilePrompt("Buy mid-caps in an uptrend", CATALOG, STRUCTURES, { callModel });
    expect(output.needs_input.some((n) => /liquidity/i.test(n.question))).toBe(false);
  });

  it("a model that tries to ask about liquidity anyway is rejected and forced to retry", async () => {
    const callModel = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        structure: "literal", conditions: [], selection_point: null, stop: null, risk_cap_pct: null, near_miss: null, t1_window: null,
        source_phrases: [], needs_input: [{ path: "liquidity", question: "What liquidity floor?" }], unsupported: [],
      }))
      .mockResolvedValueOnce(JSON.stringify({
        structure: "literal", conditions: [], selection_point: null, stop: null, risk_cap_pct: null, near_miss: null, t1_window: null,
        source_phrases: [], needs_input: [], unsupported: [],
      }));
    const { output, attempts } = await compilePrompt("x", CATALOG, STRUCTURES, { callModel });
    expect(attempts).toBe(2);
    expect(output.needs_input).toEqual([]);
  });
});

describe("compiler regression — open parameters (no fixed defaults)", () => {
  it("VStop(14,3), RSI(9), and a 3-session T1 window all compile with exactly the stated numbers, not Control's 10/2/14", async () => {
    const callModel = modelReturning({
      structure: "t1_literal",
      conditions: [
        { id: "C1", role: "event", kind: "indicator", name: "vstop", params: { length: 14, mult: 3, source: "close" }, op: "flip", dir: "long" },
        { id: "C2", role: "filter", kind: "indicator", name: "rsi", params: { length: 9 }, op: "between", value: [50, 65] },
      ],
      selection_point: { session_of_week: 1, at: "open" }, stop: { from: "C1" }, risk_cap_pct: null, near_miss: null,
      t1_window: { length_sessions: 3, offsets: [0, 1, 2] },
      source_phrases: [
        { path: "conditions.0.params.length", phrase: "VStop 14" }, { path: "conditions.0.params.mult", phrase: "3" },
        { path: "conditions.1.params.length", phrase: "RSI 9" }, { path: "conditions.1.value.0", phrase: "50" }, { path: "conditions.1.value.1", phrase: "65" },
        { path: "selection_point.session_of_week", phrase: "Monday" },
        { path: "t1_window.length_sessions", phrase: "3-session window" }, { path: "t1_window.offsets.0", phrase: "day 0" }, { path: "t1_window.offsets.1", phrase: "day 1" }, { path: "t1_window.offsets.2", phrase: "day 2" },
      ],
      needs_input: [], unsupported: [],
    });
    const { output } = await compilePrompt("...", CATALOG, STRUCTURES, { callModel });
    expect(output.conditions[0].params).toMatchObject({ length: 14, mult: 3 });
    expect(output.conditions[1].params).toMatchObject({ length: 9 });
    expect(output.t1_window).toEqual({ length_sessions: 3, offsets: [0, 1, 2] });
  });
});

describe("compiler regression — unsupported conditions never silently dropped or swapped", () => {
  it("a MACD condition lands in unsupported with the exact text, never silently matched to a similar catalog entry", async () => {
    const callModel = modelReturning({
      structure: "literal", conditions: [], selection_point: null, stop: null, risk_cap_pct: null, near_miss: null, t1_window: null,
      source_phrases: [], needs_input: [], unsupported: [{ text: "MACD crosses above signal", reason: "MACD is not in the engine's catalog" }],
    });
    const { output } = await compilePrompt("Buy on a MACD crossover", CATALOG, STRUCTURES, { callModel });
    expect(output.unsupported).toEqual([{ text: "MACD crosses above signal", reason: "MACD is not in the engine's catalog" }]);
  });

  it("the same unknown condition, if the model wrongly lists it in conditions instead of unsupported, is caught by catalog validation and forces a retry", async () => {
    const callModel = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        structure: "literal",
        conditions: [{ id: "C1", role: "event", kind: "indicator", name: "macd", params: {}, op: "cross", value: null }],
        selection_point: null, stop: null, risk_cap_pct: null, near_miss: null, t1_window: null,
        source_phrases: [], needs_input: [], unsupported: [],
      }))
      .mockResolvedValueOnce(JSON.stringify({
        structure: "literal", conditions: [], selection_point: null, stop: null, risk_cap_pct: null, near_miss: null, t1_window: null,
        source_phrases: [], needs_input: [], unsupported: [{ text: "MACD crossover", reason: "not in catalog" }],
      }));
    const { output, attempts } = await compilePrompt("Buy on a MACD crossover", CATALOG, STRUCTURES, { callModel });
    expect(attempts).toBe(2);
    expect(output.unsupported).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the regression suite**

Run: `npm run test -w apps/web -- compiler-regression.test`
Expected: PASS (7 tests)

- [ ] **Step 3: Commit**

```bash
git add frontend/apps/web/tests/compiler-regression.test.ts
git commit -m "test(web): hermetic compiler regression suite — no-invented-values, liquidity exception, open parameters, unsupported handling"
```

---

## What Phase 3 deliberately leaves out

- **A live, ≥20-prompt regression run against the real Claude API** (backend plan §10) — Task 12's suite is hermetic by design (Global Constraints); running the real thing needs `ANTHROPIC_API_KEY` set and is a manual follow-up, flagged explicitly rather than faked.
- **The parity test (P0, backend plan §4)** — proving a fully-stated-brief prompt reproduces Control's own forward record exactly is an engine-side concern already covered by `prompt-screener-engine`'s own `test(engine): P0 parity acceptance test` commit; this plan only proves the compiler *produces* that fully-stated spec, not that the engine grades it identically (already proven elsewhere).
- **Editing a draft's prompt text after a partial answer session** (re-compiling over existing answers, reconciling stale `needs_input` paths against a changed spec shape) — Phase 3 ships the straight-line path (write prompt → compile → answer → confirm); a full "edit and re-read" loop is left for a follow-up once real usage shows it's needed.

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-10-06-prompt-screener-frontend-p3.md`. One more plan (P4: sharing + multi-user login) is being written next, per your "all of P2, P3, P4" scope choice — all three will be handed off together once P4 is done, so you can review and choose execution approach (subagent-driven vs. native) once for the whole set.
