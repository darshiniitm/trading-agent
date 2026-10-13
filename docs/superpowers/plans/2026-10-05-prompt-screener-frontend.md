# Prompt Screener — Frontend Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Phase 1 of the Next.js frontend described in `docs/prompt-screener-frontend-plan.md` v3.2 §7 — a manual draft form that produces a confirmable spec, a confirm step that assigns a numeric Prompt ID and seeds a watchlist, and a Watchlist screen that shows all membership types (full match, near miss, rejected-by-risk-cap) with on-demand prices.

**Architecture:** A small npm-workspaces monorepo under `frontend/`: `packages/spec` holds zod schemas shared by the browser and the server; `apps/web` is a single Next.js (App Router, TypeScript) app that owns its own SQLite database (via drizzle, raw-SQL migrations) and calls the already-implemented Python engine (`127.0.0.1:8001`, see `engine/` in the `prompt-screener-engine` worktree, merged or not) over HTTP for screening. Route handlers in `app/api/**/route.ts` are thin HTTP glue; all real logic lives in plain, DB-injected service functions under `src/server/`, so every test calls a service function directly against an in-memory SQLite database — no running Next server, no running engine process, no network, anywhere in the test suite.

**Tech Stack:** Node 20+, Next.js 14 (App Router) + TypeScript 5, `drizzle-orm` + `better-sqlite3` (raw-SQL migration, drizzle used as query builder only), `zod`, `@tanstack/react-query`, `vitest` + `@testing-library/react` + `jsdom`.

**Spec:** `docs/prompt-screener-frontend-plan.md` v3.2 (UI, screens, §7 phase table) and `docs/prompt-screener-backend-plan.md` v3.2 (decisions D1–D11, §2 spec shape, §4 engine endpoints, §8 database design, §11 phase table — this plan implements backend P1 and the frontend-P1 slice of the UI). Engine contract reference: `docs/superpowers/plans/2026-10-04-prompt-screener-engine.md` (already implemented, Tasks 1–15, in the `prompt-screener-engine` worktree) — `GET /conditions`, `GET /structures`, `POST /screen` are consumed as-is; this plan does not modify the engine.

## Global Constraints

- **Only `literal` and `t1_literal` structures are exposed (D1).** The web app never shows or accepts any other structure value.
- **No parameter is ever fixed, defaulted, or suggested by this app (D6).** The manual draft form starts every field empty; there is no "suggested" value anywhere except liquidity.
- **Liquidity is the one exception (D3).** It is always asked, with ₹10 cr/week offered for the user to confirm, change, or decline. Declining adds no condition.
- **Every spec value stored in `prompt_conditions` carries `value_origin` of `prompt` or `user_answer`, never `default` (D6, enforced by the DB `CHECK`).** Phase 1 has no compiler, so every condition the user builds through the manual form is stored as `user_answer`.
- **Prompt numbers are assigned only at confirm, in one transaction, and are never reused (D9, backend plan §8.5).**
- **Near misses and risk-cap rejects never reach `run_results.in_forward_record` or get an `entry_price` (D8, backend plan §8.4 `CHECK` constraints).** This plan does not yet write forward records at all (that is backend P2) — this constraint matters now because the same tables are written in Phase 1's confirm step and must already respect it.
- **One watchlist per `(user_id, prompt_id)` (D10)**, enforced by `watchlists`'s `UNIQUE (user_id, prompt_id)`.
- **All ids are positive integers shown as "Prompt 12" / "Draft 58" (D11).** No UUIDs, no slugs.
- **Both processes bind to `127.0.0.1` only (backend plan §9).** The web app's engine base URL defaults to `http://127.0.0.1:8001` and is never configurable to a non-loopback host in this plan.
- **Hermetic tests only.** No test in this plan may open a real network socket or spawn the Python engine or a Next dev server. The engine HTTP client takes an injectable `fetchFn`; every DB-touching test uses an in-memory `better-sqlite3` database built from the same migration SQL the real app uses.
- **Never imply live data (frontend plan §6).** Every price shown in the UI is paired with its as-of time and "Yahoo Finance · may be delayed" source text.
- **Dry runs are never persisted in this plan.** "Dry run" calls the engine and returns a preview; it writes nothing to `runs`, `run_results`, `prompts`, or `watchlists`. (Backend plan §5 describes dry runs eventually being stored with `kind = dry_run` for history — that is out of scope here; flagging this explicitly since it is a narrowing of the backend doc's eventual design, not a decision already made for P1.)
- **Arm registration and the weekly job runner are out of scope.** Confirm seeds exactly one `runs` row (the screen done synchronously at confirm time, `kind = 'catch_up'` — chosen because semantically it is "the catch-up run for an entry that just joined mid-cycle," the closest existing `kind` value to what confirm needs; no new enum value is added). Backend plan §11 P2 ("Arm registration keyed by `prompt_id`, weekly hook, `select_entry`, `validate_prior`, `catch_up` [as a scheduled job], versioning") is a later plan.
- **Tables created in this plan's migration:** `users`, `prompt_drafts`, `prompts`, `prompt_conditions`, `watchlists`, `runs`, `symbols`, `run_results`, `watchlist_entries` — exactly the backend plan §8.4 DDL for those nine tables, verbatim. `compilations`, `entry_events`, `validations`, `quotes`, `price_daily`, `jobs` are deferred to the migrations that implement P2/P3 (compiler, jobs, grading) and are not created here.

## Review Focus

- **A condition in the manual form is missing a required param, or names something the engine's `/conditions` catalog doesn't have.** Expected: confirm returns 422 with the condition's id and a message naming the problem; nothing is written to any table. Covered in Task 8.
- **The week the engine screens has zero candidates.** Expected: confirm still succeeds, the `runs` row is written, and the watchlist opens with an empty table (not a 500, not a crash iterating an empty candidate list). Covered in Task 8 and Task 9.
- **The user declines the liquidity question.** Expected: no `traded_value_cr`-style liquidity condition is added to the spec, and the watchlist's risk-cap-only UI affordances correctly have nothing to hide (no risk cap either, in the base case) or, when a risk cap is separately set, the risk-cap tab still appears correctly keyed off `risk_cap_pct`, not off liquidity. Covered in Task 5 (service-level: updateDraft stores exactly what was answered) and Task 11 (UI: the question's three explicit choices, no pre-filled value).
- **Dry run must never write anything.** Expected: calling dry-run twice in a row, or dry-run then abandoning the draft, leaves `runs`/`run_results`/`prompts`/`watchlists` empty. Covered in Task 7.
- **Re-confirming an already-confirmed or abandoned draft.** Expected: 409/400, not a second prompt number silently minted, not a crash on the `UNIQUE(draft_id)` constraint on `prompts.draft_id`. Covered in Task 8.

---

## File Structure

```
frontend/
  package.json                                  (npm workspaces: apps/*, packages/*)
  packages/spec/
    package.json
    tsconfig.json
    src/index.ts                                 (zod schemas: Condition, SelectionPoint, Stop, NearMiss, T1Window, ScreenSpec)
  apps/web/
    package.json
    tsconfig.json
    next.config.mjs
    vitest.config.ts
    vitest.setup.ts
    app/
      layout.tsx
      page.tsx                                   (redirects to /drafts/new)
      drafts/new/page.tsx
      watchlists/[watchlistId]/page.tsx
      api/drafts/route.ts                         (POST)
      api/drafts/[draftId]/route.ts               (GET, PATCH)
      api/drafts/[draftId]/dry-run/route.ts       (POST)
      api/drafts/[draftId]/confirm/route.ts       (POST)
      api/watchlists/[watchlistId]/route.ts       (GET)
      api/quotes/route.ts                         (POST)
    src/
      server/
        db/
          migrations/0001_init.sql
          schema.ts                               (drizzle table shapes, no constraints — constraints live only in the SQL file)
          client.ts                                (singleton: opens data/app.db, WAL, foreign_keys on)
          test-db.ts                               (createTestDb(): in-memory db from the same migration SQL)
          seed.ts                                  (ensureOwnerUser(db))
        engine/
          client.ts                                (getConditions, getStructures, getHealth, screen — injectable fetchFn)
        drafts.ts                                  (createDraft, getDraft, updateDraft)
        dryrun.ts                                  (dryRunDraft)
        confirm.ts                                 (confirmDraft)
        watchlists.ts                              (getWatchlistView)
        quotes.ts                                  (getQuotes, 60s in-memory cache)
      components/
        ConditionRow.tsx
        ConditionChip.tsx
        StatusChip.tsx
        PricesBar.tsx
        WatchlistTable.tsx
    tests/
      db.test.ts
      engine-client.test.ts
      drafts.test.ts
      dryrun.test.ts
      confirm.test.ts
      watchlists.test.ts
      quotes.test.ts
      api-wiring.test.ts
      components/ConditionRow.test.tsx
      components/WatchlistTable.test.tsx
```

**Why service functions instead of testing route handlers directly:** a route handler's only job is to parse a `Request`, call a service function with plain arguments and an injected `db`, and serialize the result. Putting the branching logic there would mean every test needs a real or faked Next.js request/response cycle. Task 8's `api-wiring.test.ts` is the one task that proves the thin layer is wired correctly end-to-end for a single route; every other route gets the same treatment by inspection once the pattern is established, not by repeating full HTTP tests for logic already covered at the service level.

---

### Task 1: Monorepo scaffold, Next.js app skeleton, vitest harness

**Files:**
- Create: `frontend/package.json`, `frontend/apps/web/package.json`, `frontend/apps/web/tsconfig.json`, `frontend/apps/web/next.config.mjs`, `frontend/apps/web/next-env.d.ts`, `frontend/apps/web/vitest.config.ts`, `frontend/apps/web/vitest.setup.ts`, `frontend/apps/web/app/layout.tsx`, `frontend/apps/web/app/page.tsx`
- Test: `frontend/apps/web/tests/sanity.test.ts`

**Interfaces:**
- Produces: a working `npm install` + `npm run test -w apps/web` + `npm run dev -w apps/web` at the `frontend/` root.

- [ ] **Step 1: Write the workspace root `package.json`**

```json
{
  "name": "prompt-screener-frontend",
  "private": true,
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "dev": "npm run dev -w apps/web",
    "test": "npm run test -w apps/web",
    "build": "npm run build -w apps/web"
  }
}
```

- [ ] **Step 2: Write `apps/web/package.json`**

```json
{
  "name": "web",
  "private": true,
  "version": "0.1.0",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest run"
  },
  "dependencies": {
    "next": "14.2.5",
    "react": "18.3.1",
    "react-dom": "18.3.1",
    "@tanstack/react-query": "5.56.2",
    "drizzle-orm": "0.33.0",
    "better-sqlite3": "11.3.0",
    "zod": "3.23.8",
    "spec": "*"
  },
  "devDependencies": {
    "typescript": "5.5.4",
    "@types/node": "20.14.15",
    "@types/react": "18.3.3",
    "@types/better-sqlite3": "7.6.11",
    "vitest": "2.0.5",
    "@vitejs/plugin-react": "4.3.1",
    "@testing-library/react": "16.0.0",
    "@testing-library/jest-dom": "6.4.8",
    "jsdom": "25.0.0"
  }
}
```

- [ ] **Step 3: Write `apps/web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "preserve",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "incremental": true,
    "paths": { "@/*": ["./src/*"] },
    "plugins": [{ "name": "next" }]
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 4: Write `apps/web/next.config.mjs`, `apps/web/next-env.d.ts`**

```js
// apps/web/next.config.mjs
/** @type {import('next').NextConfig} */
const nextConfig = {};
export default nextConfig;
```

```ts
// apps/web/next-env.d.ts
/// <reference types="next" />
/// <reference types="next/image-types/global" />
```

- [ ] **Step 5: Write `apps/web/vitest.config.ts` and `apps/web/vitest.setup.ts`**

```ts
// apps/web/vitest.config.ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
});
```

```ts
// apps/web/vitest.setup.ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 6: Write the minimal app shell**

```tsx
// apps/web/app/layout.tsx
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

```tsx
// apps/web/app/page.tsx
import { redirect } from "next/navigation";

export default function Home() {
  redirect("/drafts/new");
}
```

- [ ] **Step 7: Write the failing sanity test**

```ts
// apps/web/tests/sanity.test.ts
import { describe, expect, it } from "vitest";

describe("test harness", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 8: Install and run**

Run (from `frontend/`): `npm install && npm run test -w apps/web`
Expected: PASS (1 test). If `npm install` fails on `better-sqlite3` needing a native build toolchain, note the error for the human reviewer — Task 1 has no other dependency on it yet.

- [ ] **Step 9: Commit**

```bash
git add frontend/package.json frontend/apps/web
git commit -m "chore(frontend): scaffold Next.js app + vitest harness"
```

---

### Task 2: `packages/spec` — zod schemas shared by client and server

**Files:**
- Create: `frontend/packages/spec/package.json`, `frontend/packages/spec/tsconfig.json`, `frontend/packages/spec/src/index.ts`
- Test: `frontend/apps/web/tests/spec-schemas.test.ts` (the workspace package is exercised from `apps/web` since that is the only consumer in Phase 1)

**Interfaces:**
- Produces: `Condition`, `SelectionPoint`, `Stop`, `NearMiss`, `T1Window`, `ScreenSpec` zod schemas and their inferred TS types, importable as `import { ScreenSpec } from "spec"`. Field names and shapes match `docs/prompt-screener-backend-plan.md` §2.1 exactly — these are the same field names the Python engine's `engine.schemas.ScreenSpec` (already implemented) accepts on `POST /screen`.

- [ ] **Step 1: Write `packages/spec/package.json` and `tsconfig.json`**

```json
{
  "name": "spec",
  "version": "0.1.0",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts",
  "dependencies": { "zod": "3.23.8" }
}
```

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "declaration": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 2: Write the failing test**

```ts
// apps/web/tests/spec-schemas.test.ts
import { describe, expect, it } from "vitest";
import { ConditionSchema, ScreenSpecSchema } from "spec";

describe("ConditionSchema", () => {
  it("rejects a condition missing role/kind/name/op", () => {
    expect(() => ConditionSchema.parse({ id: "C1" })).toThrow();
  });

  it("accepts a vstop flip event condition", () => {
    const c = ConditionSchema.parse({
      id: "C3", role: "event", kind: "indicator", name: "vstop",
      params: { length: 10, mult: 2, source: "close" }, op: "flip", dir: "long",
    });
    expect(c.id).toBe("C3");
  });
});

describe("ScreenSpecSchema", () => {
  it("rejects a structure other than literal/t1_literal", () => {
    expect(() =>
      ScreenSpecSchema.parse({
        spec_version: 4, structure: "control", timeframe: "1W",
        selection_point: null, conditions: [], stop: null, risk_cap_pct: null, near_miss: null,
      })
    ).toThrow();
  });

  it("accepts the full original-brief spec from backend plan §2.1", () => {
    const spec = ScreenSpecSchema.parse({
      spec_version: 4, structure: "literal", timeframe: "1W",
      selection_point: { session_of_week: 1, at: "open" },
      conditions: [
        { id: "C1", role: "filter", kind: "field", name: "mcap_cr", op: "between", value: [10000, 50000] },
        { id: "C2", role: "filter", kind: "field", name: "traded_value_cr", params: { window: "1W" }, op: ">=", value: 10 },
        { id: "C3", role: "event", kind: "indicator", name: "vstop", params: { length: 10, mult: 2, source: "close" }, op: "flip", dir: "long" },
        { id: "C4", role: "filter", kind: "indicator", name: "rsi", params: { length: 14 }, op: "between", value: [50, 65] },
      ],
      stop: { from: "C3" }, risk_cap_pct: null, near_miss: { max_failed: 1 },
    });
    expect(spec.conditions).toHaveLength(4);
    expect(spec.stop?.from).toBe("C3");
  });

  it("rejects duplicate condition ids", () => {
    expect(() =>
      ScreenSpecSchema.parse({
        spec_version: 4, structure: "literal", timeframe: "1W", selection_point: null,
        conditions: [
          { id: "C1", role: "filter", kind: "field", name: "mcap_cr", op: "between", value: [1, 2] },
          { id: "C1", role: "filter", kind: "field", name: "mcap_cr", op: "between", value: [1, 2] },
        ],
        stop: null, risk_cap_pct: null, near_miss: null,
      })
    ).toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -w apps/web -- spec-schemas`
Expected: FAIL — `Cannot find package 'spec'` (the workspace package doesn't have `src/index.ts` yet, and it isn't installed until Step 5).

- [ ] **Step 4: Write `packages/spec/src/index.ts`**

```ts
// packages/spec/src/index.ts
import { z } from "zod";

export const ConditionSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["filter", "event", "stop"]),
  kind: z.enum(["field", "indicator"]),
  name: z.string().min(1),
  params: z.record(z.any()).default({}),
  op: z.string().min(1),
  value: z.any().optional().nullable(),
  dir: z.literal("long").optional().nullable(),
});
export type Condition = z.infer<typeof ConditionSchema>;

export const SelectionPointSchema = z.object({
  session_of_week: z.number().int().min(1).max(5),
  at: z.enum(["open", "close"]),
});
export type SelectionPoint = z.infer<typeof SelectionPointSchema>;

export const StopSchema = z.object({ from: z.string().min(1) });
export type Stop = z.infer<typeof StopSchema>;

export const NearMissSchema = z.object({ max_failed: z.number().int().min(0) });
export type NearMiss = z.infer<typeof NearMissSchema>;

export const T1WindowSchema = z.object({
  length_sessions: z.number().int().min(1),
  offsets: z.array(z.number().int()),
});
export type T1Window = z.infer<typeof T1WindowSchema>;

export const ScreenSpecSchema = z
  .object({
    spec_version: z.number().int(),
    structure: z.enum(["literal", "t1_literal"]),
    timeframe: z.literal("1W"),
    selection_point: SelectionPointSchema.nullable(),
    conditions: z.array(ConditionSchema),
    stop: StopSchema.nullable(),
    risk_cap_pct: z.number().nullable(),
    near_miss: NearMissSchema.nullable(),
    t1_window: T1WindowSchema.nullable().optional(),
  })
  .superRefine((spec, ctx) => {
    const ids = spec.conditions.map((c) => c.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "condition ids must be unique" });
    }
  });
export type ScreenSpec = z.infer<typeof ScreenSpecSchema>;
```

- [ ] **Step 5: Add the workspace package to the install, run tests**

Run (from `frontend/`): `npm install && npm run test -w apps/web -- spec-schemas`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add frontend/packages/spec frontend/apps/web/tests/spec-schemas.test.ts frontend/package-lock.json
git commit -m "feat(spec): zod schemas for Condition/ScreenSpec shared by client and server"
```

---

### Task 3: SQLite schema, migration, drizzle client, seed, in-memory test DB

**Files:**
- Create: `apps/web/src/server/db/migrations/0001_init.sql`, `apps/web/src/server/db/schema.ts`, `apps/web/src/server/db/client.ts`, `apps/web/src/server/db/test-db.ts`, `apps/web/src/server/db/seed.ts`
- Test: `apps/web/tests/db.test.ts`

**Interfaces:**
- Produces: `createTestDb(): BetterSqlite3Database` (raw `better-sqlite3` handle, schema applied, foreign keys on); `db(): BetterSqlite3Database` (singleton, opens `data/app.db` relative to the repo, lazily, WAL mode); `schema.ts` exports drizzle `sqliteTable` defs: `users`, `promptDrafts`, `prompts`, `promptConditions`, `watchlists`, `runs`, `symbols`, `runResults`, `watchlistEntries`; `ensureOwnerUser(raw: BetterSqlite3Database): number` returns `user_id` (creates user 1 "Owner" if `users` is empty, otherwise returns the existing lowest-id user's id).

- [ ] **Step 1: Write `0001_init.sql`** (verbatim subset of backend plan §8.4 — the nine tables this plan needs; `compilations`, `entry_events`, `validations`, `quotes`, `price_daily`, `jobs` are left for later migrations)

```sql
-- apps/web/src/server/db/migrations/0001_init.sql
PRAGMA foreign_keys = ON;

CREATE TABLE users (
  user_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name   TEXT NOT NULL,
  email          TEXT UNIQUE,
  password_hash  TEXT,
  role           TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at     TEXT NOT NULL
);

CREATE TABLE prompt_drafts (
  draft_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(user_id),
  parent_prompt_id  INTEGER REFERENCES prompts(prompt_id),
  title             TEXT,
  prompt_text       TEXT NOT NULL CHECK (length(prompt_text) <= 2000),
  structure         TEXT CHECK (structure IN ('literal','t1_literal')),
  spec_json         TEXT CHECK (spec_json IS NULL OR json_valid(spec_json)),
  needs_input_json  TEXT CHECK (needs_input_json IS NULL OR json_valid(needs_input_json)),
  answers_json      TEXT CHECK (answers_json IS NULL OR json_valid(answers_json)),
  hypothesis        TEXT,
  kill_criterion    TEXT,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','confirmed','abandoned')),
  confirmed_prompt_id INTEGER REFERENCES prompts(prompt_id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX ix_drafts_user ON prompt_drafts(user_id, status);

CREATE TABLE prompts (
  prompt_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id     INTEGER NOT NULL REFERENCES users(user_id),
  draft_id          INTEGER NOT NULL UNIQUE REFERENCES prompt_drafts(draft_id),
  title             TEXT NOT NULL,
  prompt_text       TEXT NOT NULL CHECK (length(prompt_text) <= 2000),
  structure         TEXT NOT NULL CHECK (structure IN ('literal','t1_literal')),
  spec_json         TEXT NOT NULL CHECK (json_valid(spec_json)),
  spec_hash         TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','superseded','retired')),
  parent_prompt_id  INTEGER REFERENCES prompts(prompt_id),
  version           INTEGER NOT NULL DEFAULT 1,
  hypothesis        TEXT NOT NULL,
  kill_criterion    TEXT NOT NULL,
  tracks_stock_arm  TEXT CHECK (tracks_stock_arm IN ('literal','t1_literal')),
  review_week       INTEGER,
  confirmed_at      TEXT NOT NULL,
  closed_at         TEXT
);
CREATE INDEX ix_prompts_owner ON prompts(owner_user_id, status);
CREATE UNIQUE INDEX ux_prompts_owner_spec ON prompts(owner_user_id, spec_hash) WHERE status = 'confirmed';

CREATE TABLE prompt_conditions (
  prompt_id      INTEGER NOT NULL REFERENCES prompts(prompt_id),
  cond_no        INTEGER NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('filter','event','stop')),
  kind           TEXT NOT NULL CHECK (kind IN ('field','indicator')),
  name           TEXT NOT NULL,
  params_json    TEXT CHECK (params_json IS NULL OR json_valid(params_json)),
  op             TEXT NOT NULL,
  value_json     TEXT CHECK (value_json IS NULL OR json_valid(value_json)),
  value_origin   TEXT NOT NULL CHECK (value_origin IN ('prompt','user_answer')),
  source_phrase  TEXT,
  PRIMARY KEY (prompt_id, cond_no)
);
CREATE INDEX ix_conditions_name ON prompt_conditions(name);

CREATE TABLE watchlists (
  watchlist_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(user_id),
  prompt_id      INTEGER NOT NULL REFERENCES prompts(prompt_id),
  name           TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  archived_at    TEXT,
  UNIQUE (user_id, prompt_id)
);
CREATE INDEX ix_watchlists_prompt ON watchlists(prompt_id);

CREATE TABLE runs (
  run_id              INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt_id           INTEGER NOT NULL REFERENCES prompts(prompt_id),
  as_of               TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('scheduled','catch_up','dry_run')),
  status              TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','blocked_stale_data')),
  applied_steps_json  TEXT CHECK (applied_steps_json IS NULL OR json_valid(applied_steps_json)),
  funnel_json         TEXT CHECK (funnel_json IS NULL OR json_valid(funnel_json)),
  data_snapshot_hash  TEXT,
  engine_version      TEXT,
  forward_record_ref  TEXT,
  started_at TEXT, finished_at TEXT, error TEXT
);
CREATE UNIQUE INDEX ux_runs_graded ON runs(prompt_id, as_of) WHERE kind <> 'dry_run';

CREATE TABLE symbols (
  symbol   TEXT PRIMARY KEY,
  name     TEXT, sector TEXT, isin TEXT UNIQUE,
  active   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE run_results (
  run_id            INTEGER NOT NULL REFERENCES runs(run_id),
  symbol            TEXT NOT NULL REFERENCES symbols(symbol),
  membership        TEXT NOT NULL CHECK (membership IN ('full_match','near_miss','rejected_risk_cap')),
  in_forward_record INTEGER NOT NULL DEFAULT 0 CHECK (in_forward_record IN (0,1)),
  failed_conds_json TEXT CHECK (failed_conds_json IS NULL OR json_valid(failed_conds_json)),
  cond_json         TEXT NOT NULL CHECK (json_valid(cond_json)),
  metrics_json      TEXT CHECK (metrics_json IS NULL OR json_valid(metrics_json)),
  ep REAL, sl REAL, ref_price REAL, confidence REAL,
  window_offset INTEGER, days_since_flip INTEGER,
  entry_status      TEXT CHECK (entry_status IN ('pending_selection','entered','not_confirmed','no_point_data','watching')),
  PRIMARY KEY (run_id, symbol),
  CHECK (in_forward_record = 0 OR membership = 'full_match')
);
CREATE INDEX ix_results_membership ON run_results(run_id, membership);

CREATE TABLE watchlist_entries (
  entry_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  watchlist_id   INTEGER NOT NULL REFERENCES watchlists(watchlist_id),
  symbol         TEXT NOT NULL REFERENCES symbols(symbol),
  first_run_id   INTEGER NOT NULL REFERENCES runs(run_id),
  last_run_id    INTEGER NOT NULL REFERENCES runs(run_id),
  membership     TEXT NOT NULL CHECK (membership IN ('full_match','near_miss','rejected_risk_cap')),
  status         TEXT NOT NULL CHECK (status IN ('pending_selection','entered','not_confirmed',
                   'no_point_data','watching','dropped_from_screen','stopped_out','removed_by_user','closed')),
  entry_date TEXT, entry_price REAL, stop REAL,
  ref_price      REAL,
  user_note      TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (watchlist_id, symbol, first_run_id),
  CHECK (membership = 'full_match' OR entry_price IS NULL)
);
CREATE INDEX ix_entries_list ON watchlist_entries(watchlist_id, status, membership);
CREATE UNIQUE INDEX ux_entries_open ON watchlist_entries(watchlist_id, symbol)
  WHERE status NOT IN ('dropped_from_screen','stopped_out','removed_by_user','closed');
```

- [ ] **Step 2: Write the failing test**

```ts
// apps/web/tests/db.test.ts
import { describe, expect, it } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";

describe("createTestDb", () => {
  it("applies the migration and enforces foreign keys", () => {
    const raw = createTestDb();
    const fk = raw.pragma("foreign_keys", { simple: true });
    expect(fk).toBe(1);
    expect(() =>
      raw.prepare("INSERT INTO watchlists (user_id, prompt_id, name, created_at) VALUES (999, 999, 'x', '2026-01-01')").run()
    ).toThrow();
  });
});

describe("ensureOwnerUser", () => {
  it("creates user 1 on an empty users table", () => {
    const raw = createTestDb();
    const id = ensureOwnerUser(raw);
    expect(id).toBe(1);
    const row = raw.prepare("SELECT display_name, role FROM users WHERE user_id = 1").get() as any;
    expect(row.display_name).toBe("Owner");
    expect(row.role).toBe("owner");
  });

  it("is idempotent", () => {
    const raw = createTestDb();
    const first = ensureOwnerUser(raw);
    const second = ensureOwnerUser(raw);
    expect(second).toBe(first);
    const count = raw.prepare("SELECT COUNT(*) AS n FROM users").get() as any;
    expect(count.n).toBe(1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -w apps/web -- db.test`
Expected: FAIL — `Cannot find module '@/server/db/test-db'`

- [ ] **Step 4: Write the implementation**

```ts
// apps/web/src/server/db/test-db.ts
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const MIGRATION_PATH = path.join(__dirname, "migrations", "0001_init.sql");

export function createTestDb(): Database.Database {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  const sql = fs.readFileSync(MIGRATION_PATH, "utf-8");
  raw.exec(sql);
  return raw;
}
```

```ts
// apps/web/src/server/db/seed.ts
import type Database from "better-sqlite3";

export function ensureOwnerUser(raw: Database.Database): number {
  const existing = raw.prepare("SELECT user_id FROM users ORDER BY user_id LIMIT 1").get() as
    | { user_id: number }
    | undefined;
  if (existing) return existing.user_id;
  const now = new Date().toISOString();
  const info = raw
    .prepare("INSERT INTO users (display_name, role, status, created_at) VALUES ('Owner', 'owner', 'active', ?)")
    .run(now);
  return Number(info.lastInsertRowid);
}
```

```ts
// apps/web/src/server/db/client.ts
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { ensureOwnerUser } from "./seed";

const MIGRATION_PATH = path.join(__dirname, "migrations", "0001_init.sql");
const DB_PATH = path.join(process.cwd(), "data", "app.db");

let instance: Database.Database | null = null;

export function db(): Database.Database {
  if (instance) return instance;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const raw = new Database(DB_PATH);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  const alreadyInitialized = raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'")
    .get();
  if (!alreadyInitialized) {
    raw.exec(fs.readFileSync(MIGRATION_PATH, "utf-8"));
  }
  ensureOwnerUser(raw);
  instance = raw;
  return instance;
}
```

```ts
// apps/web/src/server/db/schema.ts
import { sqliteTable, integer, text, real } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  userId: integer("user_id").primaryKey({ autoIncrement: true }),
  displayName: text("display_name").notNull(),
  email: text("email"),
  role: text("role").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
});

export const promptDrafts = sqliteTable("prompt_drafts", {
  draftId: integer("draft_id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  parentPromptId: integer("parent_prompt_id"),
  title: text("title"),
  promptText: text("prompt_text").notNull(),
  structure: text("structure"),
  specJson: text("spec_json"),
  needsInputJson: text("needs_input_json"),
  answersJson: text("answers_json"),
  hypothesis: text("hypothesis"),
  killCriterion: text("kill_criterion"),
  status: text("status").notNull(),
  confirmedPromptId: integer("confirmed_prompt_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const prompts = sqliteTable("prompts", {
  promptId: integer("prompt_id").primaryKey({ autoIncrement: true }),
  ownerUserId: integer("owner_user_id").notNull(),
  draftId: integer("draft_id").notNull(),
  title: text("title").notNull(),
  promptText: text("prompt_text").notNull(),
  structure: text("structure").notNull(),
  specJson: text("spec_json").notNull(),
  specHash: text("spec_hash").notNull(),
  status: text("status").notNull(),
  parentPromptId: integer("parent_prompt_id"),
  version: integer("version").notNull(),
  hypothesis: text("hypothesis").notNull(),
  killCriterion: text("kill_criterion").notNull(),
  trackStockArm: text("tracks_stock_arm"),
  reviewWeek: integer("review_week"),
  confirmedAt: text("confirmed_at").notNull(),
  closedAt: text("closed_at"),
});

export const watchlists = sqliteTable("watchlists", {
  watchlistId: integer("watchlist_id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  promptId: integer("prompt_id").notNull(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
  archivedAt: text("archived_at"),
});

export const runs = sqliteTable("runs", {
  runId: integer("run_id").primaryKey({ autoIncrement: true }),
  promptId: integer("prompt_id").notNull(),
  asOf: text("as_of").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  appliedStepsJson: text("applied_steps_json"),
  funnelJson: text("funnel_json"),
  dataSnapshotHash: text("data_snapshot_hash"),
  engineVersion: text("engine_version"),
  forwardRecordRef: text("forward_record_ref"),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  error: text("error"),
});

export const symbols = sqliteTable("symbols", {
  symbol: text("symbol").primaryKey(),
  name: text("name"),
  sector: text("sector"),
  isin: text("isin"),
  active: integer("active").notNull(),
});

export const runResults = sqliteTable("run_results", {
  runId: integer("run_id").notNull(),
  symbol: text("symbol").notNull(),
  membership: text("membership").notNull(),
  inForwardRecord: integer("in_forward_record").notNull(),
  failedCondsJson: text("failed_conds_json"),
  condJson: text("cond_json").notNull(),
  metricsJson: text("metrics_json"),
  ep: real("ep"),
  sl: real("sl"),
  refPrice: real("ref_price"),
  confidence: real("confidence"),
  windowOffset: integer("window_offset"),
  daysSinceFlip: integer("days_since_flip"),
  entryStatus: text("entry_status"),
});

export const watchlistEntries = sqliteTable("watchlist_entries", {
  entryId: integer("entry_id").primaryKey({ autoIncrement: true }),
  watchlistId: integer("watchlist_id").notNull(),
  symbol: text("symbol").notNull(),
  firstRunId: integer("first_run_id").notNull(),
  lastRunId: integer("last_run_id").notNull(),
  membership: text("membership").notNull(),
  status: text("status").notNull(),
  entryDate: text("entry_date"),
  entryPrice: real("entry_price"),
  stop: real("stop"),
  refPrice: real("ref_price"),
  userNote: text("user_note"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test -w apps/web -- db.test`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add frontend/apps/web/src/server/db frontend/apps/web/tests/db.test.ts
git commit -m "feat(web): SQLite migration (9 P1 tables), drizzle schema, seed, in-memory test DB"
```

---

### Task 4: Engine HTTP client

**Files:**
- Create: `apps/web/src/server/engine/client.ts`
- Test: `apps/web/tests/engine-client.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks except `ScreenSpec` from `spec`.
- Produces: `ENGINE_BASE_URL` (`"http://127.0.0.1:8001"` unless `process.env.ENGINE_BASE_URL` is set); `getConditions(fetchFn?)`, `getStructures(fetchFn?)`, `getHealth(fetchFn?)`, `screen(spec: ScreenSpec, asOf: string, fetchFn?)` — each returns the parsed JSON body on 2xx and throws `EngineError` (fields: `status: number`, `body: unknown`) on a non-2xx response or a transport failure. `fetchFn` defaults to `globalThis.fetch` and is the only seam tests use.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/engine-client.test.ts
import { describe, expect, it, vi } from "vitest";
import { EngineError, getConditions, screen } from "@/server/engine/client";

function fakeFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

describe("getConditions", () => {
  it("returns the parsed catalog on 200", async () => {
    const fetchFn = fakeFetch(200, [{ kind: "indicator", name: "vstop" }]);
    const result = await getConditions(fetchFn as any);
    expect(result).toEqual([{ kind: "indicator", name: "vstop" }]);
    expect(fetchFn).toHaveBeenCalledWith("http://127.0.0.1:8001/conditions", expect.anything());
  });
});

describe("screen", () => {
  const spec = {
    spec_version: 4, structure: "literal" as const, timeframe: "1W" as const,
    selection_point: null, conditions: [], stop: null, risk_cap_pct: null, near_miss: null,
  };

  it("posts the spec and as_of, returns the parsed body on 200", async () => {
    const fetchFn = fakeFetch(200, { candidates: [], applied_steps: [], funnel: [], sector_view: [] });
    const result = await screen(spec, "2026-10-02", fetchFn as any);
    expect(result.candidates).toEqual([]);
    const [, init] = fetchFn.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ spec, as_of: "2026-10-02" });
  });

  it("throws EngineError with the status and body on 422", async () => {
    const fetchFn = fakeFetch(422, { errors: [{ condition_id: "C9", message: "unsupported" }] });
    await expect(screen(spec, "2026-10-02", fetchFn as any)).rejects.toMatchObject({
      status: 422,
      body: { errors: [{ condition_id: "C9", message: "unsupported" }] },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- engine-client`
Expected: FAIL — `Cannot find module '@/server/engine/client'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/server/engine/client.ts
import type { ScreenSpec } from "spec";

export const ENGINE_BASE_URL = process.env.ENGINE_BASE_URL ?? "http://127.0.0.1:8001";

export class EngineError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super(`engine request failed with status ${status}`);
    this.status = status;
    this.body = body;
  }
}

type FetchFn = typeof fetch;

async function call(path: string, init: Parameters<FetchFn>[1], fetchFn: FetchFn) {
  const res = await fetchFn(`${ENGINE_BASE_URL}${path}`, init);
  const body = await res.json();
  if (!res.ok) throw new EngineError(res.status, body);
  return body;
}

export function getConditions(fetchFn: FetchFn = fetch) {
  return call("/conditions", { method: "GET" }, fetchFn);
}

export function getStructures(fetchFn: FetchFn = fetch) {
  return call("/structures", { method: "GET" }, fetchFn);
}

export function getHealth(fetchFn: FetchFn = fetch) {
  return call("/health", { method: "GET" }, fetchFn);
}

export async function screen(spec: ScreenSpec, asOf: string, fetchFn: FetchFn = fetch) {
  return call(
    "/screen",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spec, as_of: asOf }),
    },
    fetchFn
  ) as Promise<{
    funnel: unknown[];
    applied_steps: { step: string; applied: boolean; reason: string | null }[];
    candidates: {
      ticker: string;
      membership: "full_match" | "near_miss" | "rejected_risk_cap";
      values: Record<string, unknown>;
      failed_ids: string[];
      ep: number | null;
      sl: number | null;
      r: number | null;
    }[];
    sector_view: unknown[];
  }>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w apps/web -- engine-client`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/src/server/engine frontend/apps/web/tests/engine-client.test.ts
git commit -m "feat(web): injectable-fetch client for the Python engine (/conditions, /structures, /health, /screen)"
```

---

### Task 5: Draft service (`createDraft`, `getDraft`, `updateDraft`)

**Files:**
- Create: `apps/web/src/server/drafts.ts`
- Test: `apps/web/tests/drafts.test.ts`

**Interfaces:**
- Consumes: `createTestDb`, `ensureOwnerUser` from Task 3.
- Produces: `createDraft(raw, { userId }): { draftId: number }`; `getDraft(raw, draftId): DraftRow | null`; `updateDraft(raw, draftId, patch: Partial<{ title, promptText, structure, specJson, hypothesis, killCriterion }>): DraftRow`. `DraftRow` mirrors the `prompt_drafts` columns in camelCase, with `specJson` already `JSON.parse`d into `spec: ScreenSpec | null`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/drafts.test.ts
import { describe, expect, it } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { createDraft, getDraft, updateDraft } from "@/server/drafts";

function setup() {
  const raw = createTestDb();
  const userId = ensureOwnerUser(raw);
  return { raw, userId };
}

describe("createDraft", () => {
  it("creates an open draft with an empty prompt_text and no spec", () => {
    const { raw, userId } = setup();
    const { draftId } = createDraft(raw, { userId });
    const row = getDraft(raw, draftId)!;
    expect(row.status).toBe("open");
    expect(row.promptText).toBe("");
    expect(row.spec).toBeNull();
  });
});

describe("updateDraft", () => {
  it("stores structure and a spec built from manual condition rows", () => {
    const { raw, userId } = setup();
    const { draftId } = createDraft(raw, { userId });
    const spec = {
      spec_version: 4, structure: "literal" as const, timeframe: "1W" as const,
      selection_point: { session_of_week: 1, at: "open" as const },
      conditions: [
        { id: "C1", role: "filter" as const, kind: "field" as const, name: "mcap_cr", params: {}, op: "between", value: [10000, 50000] },
      ],
      stop: null, risk_cap_pct: null, near_miss: null,
    };
    const updated = updateDraft(raw, draftId, {
      structure: "literal",
      specJson: JSON.stringify(spec),
      hypothesis: "mid-caps in an uptrend outperform",
      killCriterion: "negative expectancy after 13 weeks",
    });
    expect(updated.structure).toBe("literal");
    expect(updated.spec?.conditions).toHaveLength(1);
    expect(updated.hypothesis).toBe("mid-caps in an uptrend outperform");
  });

  it("bumps updated_at and throws on an unknown draft id", () => {
    const { raw } = setup();
    expect(() => updateDraft(raw, 999, { title: "x" })).toThrow(/draft 999 not found/);
  });

  it("rejects a prompt_text over 2000 chars (DB CHECK) with a clear error, not a raw SQLite exception", () => {
    const { raw, userId } = setup();
    const { draftId } = createDraft(raw, { userId });
    expect(() => updateDraft(raw, draftId, { promptText: "x".repeat(2001) })).toThrow(/2000/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- drafts.test`
Expected: FAIL — `Cannot find module '@/server/drafts'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/server/drafts.ts
import type Database from "better-sqlite3";
import type { ScreenSpec } from "spec";

export type DraftRow = {
  draftId: number;
  userId: number;
  title: string | null;
  promptText: string;
  structure: "literal" | "t1_literal" | null;
  spec: ScreenSpec | null;
  hypothesis: string | null;
  killCriterion: string | null;
  status: "open" | "confirmed" | "abandoned";
  confirmedPromptId: number | null;
  createdAt: string;
  updatedAt: string;
};

function rowToDraft(row: any): DraftRow {
  return {
    draftId: row.draft_id,
    userId: row.user_id,
    title: row.title,
    promptText: row.prompt_text,
    structure: row.structure,
    spec: row.spec_json ? JSON.parse(row.spec_json) : null,
    hypothesis: row.hypothesis,
    killCriterion: row.kill_criterion,
    status: row.status,
    confirmedPromptId: row.confirmed_prompt_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createDraft(raw: Database.Database, { userId }: { userId: number }): { draftId: number } {
  const now = new Date().toISOString();
  const info = raw
    .prepare(
      `INSERT INTO prompt_drafts (user_id, prompt_text, status, created_at, updated_at)
       VALUES (?, '', 'open', ?, ?)`
    )
    .run(userId, now, now);
  return { draftId: Number(info.lastInsertRowid) };
}

export function getDraft(raw: Database.Database, draftId: number): DraftRow | null {
  const row = raw.prepare("SELECT * FROM prompt_drafts WHERE draft_id = ?").get(draftId);
  return row ? rowToDraft(row) : null;
}

type DraftPatch = Partial<{
  title: string;
  promptText: string;
  structure: "literal" | "t1_literal";
  specJson: string;
  hypothesis: string;
  killCriterion: string;
}>;

const COLUMN_BY_KEY: Record<keyof DraftPatch, string> = {
  title: "title",
  promptText: "prompt_text",
  structure: "structure",
  specJson: "spec_json",
  hypothesis: "hypothesis",
  killCriterion: "kill_criterion",
};

export function updateDraft(raw: Database.Database, draftId: number, patch: DraftPatch): DraftRow {
  const existing = raw.prepare("SELECT draft_id FROM prompt_drafts WHERE draft_id = ?").get(draftId);
  if (!existing) throw new Error(`draft ${draftId} not found`);

  const keys = Object.keys(patch) as (keyof DraftPatch)[];
  if (keys.length > 0) {
    const assignments = keys.map((k) => `${COLUMN_BY_KEY[k]} = ?`).join(", ");
    const values = keys.map((k) => patch[k]);
    try {
      raw
        .prepare(`UPDATE prompt_drafts SET ${assignments}, updated_at = ? WHERE draft_id = ?`)
        .run(...values, new Date().toISOString(), draftId);
    } catch (err: any) {
      if (String(err.message).includes("CHECK constraint failed") && keys.includes("promptText")) {
        throw new Error("prompt_text must be 2000 characters or fewer");
      }
      throw err;
    }
  }
  return getDraft(raw, draftId)!;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w apps/web -- drafts.test`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/src/server/drafts.ts frontend/apps/web/tests/drafts.test.ts
git commit -m "feat(web): draft service — createDraft/getDraft/updateDraft"
```

---

### Task 6: Draft API routes (thin wiring over Task 5)

**Files:**
- Create: `apps/web/app/api/drafts/route.ts`, `apps/web/app/api/drafts/[draftId]/route.ts`
- Test: `apps/web/tests/api-wiring.test.ts`

**Interfaces:**
- Consumes: `createDraft`, `getDraft`, `updateDraft` (Task 5), `db()` (Task 3).
- Produces: `POST /api/drafts` → `201 { draft_id }`; `GET /api/drafts/:draftId` → `200 DraftRow` (camelCase→snake_case at the boundary) or `404`; `PATCH /api/drafts/:draftId` → `200 DraftRow` or `404`/`400`. This is the one route pair that gets a full `Request`-in/`Response`-out test; every later route task follows the same pattern by inspection rather than repeating this proof.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/api-wiring.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockDb = { marker: "db" };
vi.mock("@/server/db/client", () => ({ db: () => mockDb }));
vi.mock("@/server/drafts", () => ({
  createDraft: vi.fn(() => ({ draftId: 7 })),
  getDraft: vi.fn((raw: unknown, id: number) =>
    id === 7 ? { draftId: 7, status: "open", promptText: "", spec: null } : null
  ),
  updateDraft: vi.fn((raw: unknown, id: number, patch: unknown) => ({ draftId: id, ...patch })),
}));

import { POST as createDraftRoute } from "@/../app/api/drafts/route";
import { GET as getDraftRoute, PATCH as patchDraftRoute } from "@/../app/api/drafts/[draftId]/route";

beforeEach(() => vi.clearAllMocks());

describe("POST /api/drafts", () => {
  it("returns 201 with the new draft_id", async () => {
    const res = await createDraftRoute(new Request("http://localhost/api/drafts", { method: "POST" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ draft_id: 7 });
  });
});

describe("GET /api/drafts/:draftId", () => {
  it("returns 200 for an existing draft", async () => {
    const res = await getDraftRoute(new Request("http://localhost/api/drafts/7"), { params: { draftId: "7" } });
    expect(res.status).toBe(200);
  });

  it("returns 404 for a missing draft", async () => {
    const res = await getDraftRoute(new Request("http://localhost/api/drafts/999"), { params: { draftId: "999" } });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/drafts/:draftId", () => {
  it("forwards the JSON body as the patch", async () => {
    const res = await patchDraftRoute(
      new Request("http://localhost/api/drafts/7", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "My prompt" }),
      }),
      { params: { draftId: "7" } }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ title: "My prompt" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- api-wiring`
Expected: FAIL — `Cannot find module '@/../app/api/drafts/route'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/app/api/drafts/route.ts
import { db } from "@/server/db/client";
import { createDraft } from "@/server/drafts";

const OWNER_USER_ID = 1;

export async function POST() {
  const { draftId } = createDraft(db(), { userId: OWNER_USER_ID });
  return Response.json({ draft_id: draftId }, { status: 201 });
}
```

```ts
// apps/web/app/api/drafts/[draftId]/route.ts
import { db } from "@/server/db/client";
import { getDraft, updateDraft } from "@/server/drafts";

export async function GET(_req: Request, { params }: { params: { draftId: string } }) {
  const draft = getDraft(db(), Number(params.draftId));
  if (!draft) return Response.json({ error: "draft not found" }, { status: 404 });
  return Response.json(draft);
}

export async function PATCH(req: Request, { params }: { params: { draftId: string } }) {
  const patch = await req.json();
  try {
    const draft = updateDraft(db(), Number(params.draftId), patch);
    return Response.json(draft);
  } catch (err: any) {
    const status = /not found/.test(err.message) ? 404 : 400;
    return Response.json({ error: err.message }, { status });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w apps/web -- api-wiring`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/app/api/drafts frontend/apps/web/tests/api-wiring.test.ts
git commit -m "feat(web): wire POST/GET/PATCH draft routes over the draft service"
```

---

### Task 7: Dry-run service + route (never persists)

**Files:**
- Create: `apps/web/src/server/dryrun.ts`, `apps/web/app/api/drafts/[draftId]/dry-run/route.ts`
- Test: `apps/web/tests/dryrun.test.ts`

**Interfaces:**
- Consumes: `getDraft` (Task 5), `screen`/`EngineError` (Task 4).
- Produces: `dryRunDraft(raw, draftId, asOf, fetchFn?): EngineScreenResult` — reads the draft's current `spec`, calls `screen()`, returns the result unchanged. Throws `Error("draft has no spec yet")` if `draft.spec` is null. Throws the underlying `EngineError` unchanged on a 422 (the caller/route maps it to HTTP 422).

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/dryrun.test.ts
import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { createDraft, updateDraft } from "@/server/drafts";
import { dryRunDraft } from "@/server/dryrun";
import { EngineError } from "@/server/engine/client";

const SPEC = {
  spec_version: 4, structure: "literal" as const, timeframe: "1W" as const,
  selection_point: null,
  conditions: [{ id: "C1", role: "filter" as const, kind: "field" as const, name: "mcap_cr", params: {}, op: "between", value: [10000, 50000] }],
  stop: null, risk_cap_pct: null, near_miss: null,
};

function draftWithSpec(spec: unknown) {
  const raw = createTestDb();
  const userId = ensureOwnerUser(raw);
  const { draftId } = createDraft(raw, { userId });
  if (spec) updateDraft(raw, draftId, { structure: "literal", specJson: JSON.stringify(spec) });
  return { raw, draftId };
}

describe("dryRunDraft", () => {
  it("calls the engine with the draft's current spec and returns the result unchanged", async () => {
    const { raw, draftId } = draftWithSpec(SPEC);
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ ticker: "ABC" }], applied_steps: [], funnel: [], sector_view: [] }),
    });
    const result = await dryRunDraft(raw, draftId, "2026-10-02", fetchFn as any);
    expect(result.candidates).toEqual([{ ticker: "ABC" }]);
    const [, init] = fetchFn.mock.calls[0];
    expect(JSON.parse(init.body).spec).toEqual(SPEC);
  });

  it("writes nothing to runs/run_results/prompts/watchlists", async () => {
    const { raw, draftId } = draftWithSpec(SPEC);
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ candidates: [], applied_steps: [], funnel: [], sector_view: [] }) });
    await dryRunDraft(raw, draftId, "2026-10-02", fetchFn as any);
    await dryRunDraft(raw, draftId, "2026-10-02", fetchFn as any);
    for (const table of ["runs", "run_results", "prompts", "watchlists"]) {
      const count = raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any;
      expect(count.n).toBe(0);
    }
  });

  it("throws if the draft has no spec yet", async () => {
    const { raw, draftId } = draftWithSpec(null);
    await expect(dryRunDraft(raw, draftId, "2026-10-02", vi.fn() as any)).rejects.toThrow(/no spec yet/);
  });

  it("propagates an EngineError from a 422 unchanged", async () => {
    const { raw, draftId } = draftWithSpec(SPEC);
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false, status: 422, json: async () => ({ errors: [{ condition_id: "C1", message: "bad" }] }),
    });
    await expect(dryRunDraft(raw, draftId, "2026-10-02", fetchFn as any)).rejects.toBeInstanceOf(EngineError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- dryrun.test`
Expected: FAIL — `Cannot find module '@/server/dryrun'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/server/dryrun.ts
import type Database from "better-sqlite3";
import { getDraft } from "@/server/drafts";
import { screen } from "@/server/engine/client";

export async function dryRunDraft(raw: Database.Database, draftId: number, asOf: string, fetchFn?: typeof fetch) {
  const draft = getDraft(raw, draftId);
  if (!draft) throw new Error(`draft ${draftId} not found`);
  if (!draft.spec) throw new Error("draft has no spec yet");
  return screen(draft.spec, asOf, fetchFn);
}
```

```ts
// apps/web/app/api/drafts/[draftId]/dry-run/route.ts
import { db } from "@/server/db/client";
import { dryRunDraft } from "@/server/dryrun";
import { EngineError } from "@/server/engine/client";

export async function POST(req: Request, { params }: { params: { draftId: string } }) {
  const { as_of } = await req.json();
  try {
    const result = await dryRunDraft(db(), Number(params.draftId), as_of);
    return Response.json(result);
  } catch (err) {
    if (err instanceof EngineError) return Response.json(err.body, { status: err.status });
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w apps/web -- dryrun.test`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/src/server/dryrun.ts frontend/apps/web/app/api/drafts/[draftId]/dry-run frontend/apps/web/tests/dryrun.test.ts
git commit -m "feat(web): dry-run service — previews the engine screen, persists nothing"
```

---

### Task 8: Confirm service + route (assigns the Prompt ID, seeds the watchlist)

**Files:**
- Create: `apps/web/src/server/confirm.ts`, `apps/web/app/api/drafts/[draftId]/confirm/route.ts`
- Test: `apps/web/tests/confirm.test.ts`

**Interfaces:**
- Consumes: `getDraft` (Task 5), `screen`/`EngineError` (Task 4), the `prompts`/`prompt_conditions`/`watchlists`/`runs`/`run_results`/`watchlist_entries`/`symbols` tables (Task 3).
- Produces: `confirmDraft(raw, draftId, asOf, fetchFn?): { promptId: number; watchlistId: number }`. Validates the confirm gate (spec present, structure present, `hypothesis` and `killCriterion` non-empty, draft `status === 'open'`), calls the engine once, and — in a single `better-sqlite3` transaction — writes `prompts`, `prompt_conditions` (every condition `value_origin = 'user_answer'`, per the Global Constraints note that Phase 1 has no compiler), `watchlists`, one `runs` row (`kind = 'catch_up'`, `status = 'done'`), one `run_results` row per candidate, one `watchlist_entries` row per candidate, and marks the draft `confirmed`. Throws `Error` with a message starting `"confirm blocked:"` for any gate failure (caller maps to 400); propagates `EngineError` unchanged on an engine-side 422 (caller maps to 422); throws `Error("draft already confirmed")` / `Error("draft is abandoned")` if `status !== 'open'`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/confirm.test.ts
import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { createDraft, updateDraft, getDraft } from "@/server/drafts";
import { confirmDraft } from "@/server/confirm";
import { EngineError } from "@/server/engine/client";

const SPEC = {
  spec_version: 4, structure: "literal" as const, timeframe: "1W" as const,
  selection_point: { session_of_week: 1, at: "open" as const },
  conditions: [
    { id: "C1", role: "filter" as const, kind: "field" as const, name: "mcap_cr", params: {}, op: "between", value: [10000, 50000] },
    { id: "C3", role: "event" as const, kind: "indicator" as const, name: "vstop", params: { length: 10, mult: 2, source: "close" }, op: "flip", dir: "long" as const },
  ],
  stop: { from: "C3" }, risk_cap_pct: null, near_miss: { max_failed: 1 },
};

function readyDraft(raw: ReturnType<typeof createTestDb>, overrides: Record<string, unknown> = {}) {
  const userId = ensureOwnerUser(raw);
  const { draftId } = createDraft(raw, { userId });
  updateDraft(raw, draftId, {
    title: "Original brief", structure: "literal", specJson: JSON.stringify(SPEC),
    hypothesis: "mid-caps in an uptrend outperform",
    killCriterion: "negative expectancy after 13 weeks",
    ...overrides,
  });
  return draftId;
}

function fakeScreenFetch(candidates: any[]) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ candidates, applied_steps: [{ step: "x", applied: true, reason: null }], funnel: [], sector_view: [] }),
  });
}

describe("confirmDraft", () => {
  it("mints a prompt_id, a watchlist, and one entry per candidate across all membership types", async () => {
    const raw = createTestDb();
    const draftId = readyDraft(raw);
    const fetchFn = fakeScreenFetch([
      { ticker: "FULL1", membership: "full_match", values: {}, failed_ids: [], ep: 101.5, sl: 95.0, r: 0.064 },
      { ticker: "NEAR1", membership: "near_miss", values: {}, failed_ids: ["C1"], ep: 50.0, sl: null, r: null },
      { ticker: "RISK1", membership: "rejected_risk_cap", values: {}, failed_ids: [], ep: 20.0, sl: 19.0, r: 0.05 },
    ]);

    const { promptId, watchlistId } = await confirmDraft(raw, draftId, "2026-10-02", fetchFn as any);
    expect(promptId).toBeGreaterThan(0);
    expect(watchlistId).toBeGreaterThan(0);

    const prompt = raw.prepare("SELECT * FROM prompts WHERE prompt_id = ?").get(promptId) as any;
    expect(prompt.status).toBe("confirmed");
    expect(prompt.version).toBe(1);

    const conditions = raw.prepare("SELECT value_origin FROM prompt_conditions WHERE prompt_id = ?").all(promptId) as any[];
    expect(conditions).toHaveLength(2);
    expect(conditions.every((c) => c.value_origin === "user_answer")).toBe(true);

    const entries = raw.prepare("SELECT symbol, membership, status, entry_price FROM watchlist_entries WHERE watchlist_id = ? ORDER BY symbol").all(watchlistId) as any[];
    expect(entries).toEqual([
      { symbol: "FULL1", membership: "full_match", status: "pending_selection", entry_price: null },
      { symbol: "NEAR1", membership: "near_miss", status: "watching", entry_price: null },
      { symbol: "RISK1", membership: "rejected_risk_cap", status: "watching", entry_price: null },
    ]);

    const results = raw.prepare("SELECT in_forward_record FROM run_results WHERE run_id = (SELECT MAX(run_id) FROM runs)").all() as any[];
    expect(results.every((r) => r.in_forward_record === 0)).toBe(true);

    const draft = getDraft(raw, draftId)!;
    expect(draft.status).toBe("confirmed");
    expect(draft.confirmedPromptId).toBe(promptId);
  });

  it("handles a week with zero candidates without crashing", async () => {
    const raw = createTestDb();
    const draftId = readyDraft(raw);
    const { watchlistId } = await confirmDraft(raw, draftId, "2026-10-02", fakeScreenFetch([]) as any);
    const entries = raw.prepare("SELECT COUNT(*) AS n FROM watchlist_entries WHERE watchlist_id = ?").get(watchlistId) as any;
    expect(entries.n).toBe(0);
  });

  it("blocks when hypothesis is missing", async () => {
    const raw = createTestDb();
    const draftId = readyDraft(raw, { hypothesis: "" });
    await expect(confirmDraft(raw, draftId, "2026-10-02", fakeScreenFetch([]) as any)).rejects.toThrow(/confirm blocked:/);
  });

  it("blocks when the spec is missing", async () => {
    const raw = createTestDb();
    const userId = ensureOwnerUser(raw);
    const { draftId } = createDraft(raw, { userId });
    await expect(confirmDraft(raw, draftId, "2026-10-02", fakeScreenFetch([]) as any)).rejects.toThrow(/confirm blocked:/);
  });

  it("propagates a 422 from the engine without writing anything", async () => {
    const raw = createTestDb();
    const draftId = readyDraft(raw);
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 422, json: async () => ({ errors: [{ condition_id: "C3", message: "unsupported" }] }) });
    await expect(confirmDraft(raw, draftId, "2026-10-02", fetchFn as any)).rejects.toBeInstanceOf(EngineError);
    const count = raw.prepare("SELECT COUNT(*) AS n FROM prompts").get() as any;
    expect(count.n).toBe(0);
  });

  it("rejects confirming an already-confirmed draft", async () => {
    const raw = createTestDb();
    const draftId = readyDraft(raw);
    await confirmDraft(raw, draftId, "2026-10-02", fakeScreenFetch([]) as any);
    await expect(confirmDraft(raw, draftId, "2026-10-09", fakeScreenFetch([]) as any)).rejects.toThrow(/already confirmed/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- confirm.test`
Expected: FAIL — `Cannot find module '@/server/confirm'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/server/confirm.ts
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { getDraft } from "@/server/drafts";
import { screen } from "@/server/engine/client";

function statusFor(membership: string): string {
  return membership === "full_match" ? "pending_selection" : "watching";
}

export async function confirmDraft(
  raw: Database.Database,
  draftId: number,
  asOf: string,
  fetchFn?: typeof fetch
): Promise<{ promptId: number; watchlistId: number }> {
  const draft = getDraft(raw, draftId);
  if (!draft) throw new Error(`draft ${draftId} not found`);
  if (draft.status === "confirmed") throw new Error("draft already confirmed");
  if (draft.status === "abandoned") throw new Error("draft is abandoned");

  const problems: string[] = [];
  if (!draft.spec) problems.push("no spec");
  if (!draft.structure) problems.push("no structure");
  if (!draft.hypothesis) problems.push("no hypothesis");
  if (!draft.killCriterion) problems.push("no kill criterion");
  if (problems.length > 0) throw new Error(`confirm blocked: ${problems.join(", ")}`);

  const specJson = JSON.stringify(draft.spec);
  const specHash = createHash("sha256").update(specJson).digest("hex");

  const screenResult = await screen(draft.spec!, asOf, fetchFn);

  const now = new Date().toISOString();
  const run = raw.transaction(() => {
    const promptInfo = raw
      .prepare(
        `INSERT INTO prompts
           (owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash,
            status, version, hypothesis, kill_criterion, confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', 1, ?, ?, ?)`
      )
      .run(
        draft.userId, draftId, draft.title ?? `Prompt from draft ${draftId}`, draft.promptText,
        draft.structure, specJson, specHash, draft.hypothesis, draft.killCriterion, now
      );
    const promptId = Number(promptInfo.lastInsertRowid);

    draft.spec!.conditions.forEach((cond, i) => {
      raw
        .prepare(
          `INSERT INTO prompt_conditions (prompt_id, cond_no, role, kind, name, params_json, op, value_json, value_origin)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'user_answer')`
        )
        .run(promptId, i + 1, cond.role, cond.kind, cond.name, JSON.stringify(cond.params ?? {}), cond.op, JSON.stringify(cond.value ?? null));
    });

    const watchlistInfo = raw
      .prepare(`INSERT INTO watchlists (user_id, prompt_id, name, created_at) VALUES (?, ?, ?, ?)`)
      .run(draft.userId, promptId, draft.title ?? `Prompt ${promptId}`, now);
    const watchlistId = Number(watchlistInfo.lastInsertRowid);

    const runInfo = raw
      .prepare(
        `INSERT INTO runs (prompt_id, as_of, kind, status, applied_steps_json, funnel_json, finished_at)
         VALUES (?, ?, 'catch_up', 'done', ?, ?, ?)`
      )
      .run(promptId, asOf, JSON.stringify(screenResult.applied_steps), JSON.stringify(screenResult.funnel), now);
    const runId = Number(runInfo.lastInsertRowid);

    for (const candidate of screenResult.candidates) {
      raw
        .prepare(`INSERT OR IGNORE INTO symbols (symbol, active) VALUES (?, 1)`)
        .run(candidate.ticker);

      const entryStatus = statusFor(candidate.membership);
      raw
        .prepare(
          `INSERT INTO run_results
             (run_id, symbol, membership, in_forward_record, failed_conds_json, cond_json, metrics_json,
              ep, sl, ref_price, confidence, entry_status)
           VALUES (?, ?, ?, 0, ?, ?, NULL, ?, ?, ?, NULL, ?)`
        )
        .run(
          runId, candidate.ticker, candidate.membership, JSON.stringify(candidate.failed_ids), JSON.stringify(candidate.values),
          candidate.membership === "full_match" ? candidate.ep : null,
          candidate.membership === "full_match" ? candidate.sl : null,
          candidate.membership === "full_match" ? null : candidate.ep,
          entryStatus
        );

      raw
        .prepare(
          `INSERT INTO watchlist_entries
             (watchlist_id, symbol, first_run_id, last_run_id, membership, status, ref_price, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          watchlistId, candidate.ticker, runId, runId, candidate.membership, entryStatus,
          candidate.membership === "full_match" ? null : candidate.ep, now, now
        );
    }

    raw
      .prepare(`UPDATE prompt_drafts SET status = 'confirmed', confirmed_prompt_id = ?, updated_at = ? WHERE draft_id = ?`)
      .run(promptId, now, draftId);

    return { promptId, watchlistId };
  });

  return run();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w apps/web -- confirm.test`
Expected: PASS (6 tests)

- [ ] **Step 5: Write the route**

```ts
// apps/web/app/api/drafts/[draftId]/confirm/route.ts
import { db } from "@/server/db/client";
import { confirmDraft } from "@/server/confirm";
import { EngineError } from "@/server/engine/client";

export async function POST(req: Request, { params }: { params: { draftId: string } }) {
  const { as_of } = await req.json();
  try {
    const { promptId, watchlistId } = await confirmDraft(db(), Number(params.draftId), as_of);
    return Response.json({ prompt_id: promptId, watchlist_id: watchlistId }, { status: 201 });
  } catch (err) {
    if (err instanceof EngineError) return Response.json(err.body, { status: err.status });
    const status = /already confirmed|abandoned/.test((err as Error).message) ? 409 : 400;
    return Response.json({ error: (err as Error).message }, { status });
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add frontend/apps/web/src/server/confirm.ts frontend/apps/web/app/api/drafts/[draftId]/confirm frontend/apps/web/tests/confirm.test.ts
git commit -m "feat(web): confirm service — mints prompt_id, seeds watchlist with all membership types, in one transaction"
```

---

### Task 9: Watchlist read service + route

**Files:**
- Create: `apps/web/src/server/watchlists.ts`, `apps/web/app/api/watchlists/[watchlistId]/route.ts`
- Test: `apps/web/tests/watchlists.test.ts`

**Interfaces:**
- Consumes: `watchlists`/`prompts`/`prompt_conditions`/`watchlist_entries`/`run_results`/`runs` tables (Task 3).
- Produces: `getWatchlistView(raw, watchlistId): WatchlistView | null`, where `WatchlistView` is:
  ```ts
  {
    watchlistId: number; promptId: number; title: string; structure: "literal" | "t1_literal";
    hypothesis: string; killCriterion: string;
    conditions: { condNo: number; role: string; kind: string; name: string; params: unknown; op: string; value: unknown; valueOrigin: "prompt" | "user_answer" }[];
    hasRiskCap: boolean;
    lastRun: { runId: number; asOf: string; appliedSteps: unknown[] } | null;
    entries: { entryId: number; symbol: string; membership: string; status: string; entryPrice: number | null; stop: number | null; refPrice: number | null; condValues: Record<string, unknown>; failedIds: string[] }[];
  }
  ```
  `hasRiskCap` is read from the prompt's own `spec_json.risk_cap_pct !== null` (frontend plan §3.1: "The risk-cap tab only appears when the prompt sets a risk cap").

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/watchlists.test.ts
import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { createDraft, updateDraft } from "@/server/drafts";
import { confirmDraft } from "@/server/confirm";
import { getWatchlistView } from "@/server/watchlists";

const SPEC = {
  spec_version: 4, structure: "literal" as const, timeframe: "1W" as const,
  selection_point: { session_of_week: 1, at: "open" as const },
  conditions: [{ id: "C1", role: "filter" as const, kind: "field" as const, name: "mcap_cr", params: {}, op: "between", value: [10000, 50000] }],
  stop: null, risk_cap_pct: null, near_miss: { max_failed: 1 },
};

async function confirmedWatchlist(fetchFn: any) {
  const raw = createTestDb();
  const userId = ensureOwnerUser(raw);
  const { draftId } = createDraft(raw, { userId });
  updateDraft(raw, draftId, {
    title: "My brief", structure: "literal", specJson: JSON.stringify(SPEC),
    hypothesis: "h", killCriterion: "k",
  });
  const { watchlistId } = await confirmDraft(raw, draftId, "2026-10-02", fetchFn);
  return { raw, watchlistId };
}

describe("getWatchlistView", () => {
  it("returns null for an unknown watchlist", () => {
    const raw = createTestDb();
    expect(getWatchlistView(raw, 999)).toBeNull();
  });

  it("assembles header, conditions, and entries across membership types", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          { ticker: "FULL1", membership: "full_match", values: { C1: 25000 }, failed_ids: [], ep: 101.5, sl: 95.0, r: 0.064 },
          { ticker: "NEAR1", membership: "near_miss", values: { C1: 9000 }, failed_ids: ["C1"], ep: 50.0, sl: null, r: null },
        ],
        applied_steps: [{ step: "evaluate_on_completed_weekly_bar", applied: true, reason: null }],
        funnel: [], sector_view: [],
      }),
    });
    const { raw, watchlistId } = await confirmedWatchlist(fetchFn);

    const view = getWatchlistView(raw, watchlistId)!;
    expect(view.title).toBe("My brief");
    expect(view.hasRiskCap).toBe(false);
    expect(view.conditions).toHaveLength(1);
    expect(view.conditions[0].valueOrigin).toBe("user_answer");
    expect(view.lastRun?.asOf).toBe("2026-10-02");

    const bySymbol = Object.fromEntries(view.entries.map((e) => [e.symbol, e]));
    expect(bySymbol.FULL1.membership).toBe("full_match");
    expect(bySymbol.FULL1.condValues).toEqual({ C1: 25000 });
    expect(bySymbol.NEAR1.membership).toBe("near_miss");
    expect(bySymbol.NEAR1.failedIds).toEqual(["C1"]);
  });

  it("handles a watchlist whose latest run had zero candidates", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ candidates: [], applied_steps: [], funnel: [], sector_view: [] }) });
    const { raw, watchlistId } = await confirmedWatchlist(fetchFn);
    const view = getWatchlistView(raw, watchlistId)!;
    expect(view.entries).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- watchlists.test`
Expected: FAIL — `Cannot find module '@/server/watchlists'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/server/watchlists.ts
import type Database from "better-sqlite3";

export function getWatchlistView(raw: Database.Database, watchlistId: number) {
  const watchlist = raw.prepare("SELECT * FROM watchlists WHERE watchlist_id = ?").get(watchlistId) as any;
  if (!watchlist) return null;

  const prompt = raw.prepare("SELECT * FROM prompts WHERE prompt_id = ?").get(watchlist.prompt_id) as any;
  const spec = JSON.parse(prompt.spec_json);

  const conditions = (raw.prepare("SELECT * FROM prompt_conditions WHERE prompt_id = ? ORDER BY cond_no").all(prompt.prompt_id) as any[]).map(
    (c) => ({
      condNo: c.cond_no, role: c.role, kind: c.kind, name: c.name,
      params: c.params_json ? JSON.parse(c.params_json) : null,
      op: c.op, value: c.value_json ? JSON.parse(c.value_json) : null,
      valueOrigin: c.value_origin,
    })
  );

  const lastRunRow = raw
    .prepare("SELECT * FROM runs WHERE prompt_id = ? ORDER BY run_id DESC LIMIT 1")
    .get(prompt.prompt_id) as any;
  const lastRun = lastRunRow
    ? { runId: lastRunRow.run_id, asOf: lastRunRow.as_of, appliedSteps: JSON.parse(lastRunRow.applied_steps_json ?? "[]") }
    : null;

  const entries = (raw
    .prepare("SELECT * FROM watchlist_entries WHERE watchlist_id = ? ORDER BY symbol")
    .all(watchlistId) as any[]).map((e) => {
    const result = raw
      .prepare("SELECT cond_json, failed_conds_json FROM run_results WHERE run_id = ? AND symbol = ?")
      .get(e.last_run_id, e.symbol) as any;
    return {
      entryId: e.entry_id, symbol: e.symbol, membership: e.membership, status: e.status,
      entryPrice: e.entry_price, stop: e.stop, refPrice: e.ref_price,
      condValues: result ? JSON.parse(result.cond_json) : {},
      failedIds: result?.failed_conds_json ? JSON.parse(result.failed_conds_json) : [],
    };
  });

  return {
    watchlistId: watchlist.watchlist_id, promptId: prompt.prompt_id, title: prompt.title,
    structure: prompt.structure, hypothesis: prompt.hypothesis, killCriterion: prompt.kill_criterion,
    conditions, hasRiskCap: spec.risk_cap_pct !== null && spec.risk_cap_pct !== undefined,
    lastRun, entries,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w apps/web -- watchlists.test`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the route**

```ts
// apps/web/app/api/watchlists/[watchlistId]/route.ts
import { db } from "@/server/db/client";
import { getWatchlistView } from "@/server/watchlists";

export async function GET(_req: Request, { params }: { params: { watchlistId: string } }) {
  const view = getWatchlistView(db(), Number(params.watchlistId));
  if (!view) return Response.json({ error: "watchlist not found" }, { status: 404 });
  return Response.json(view);
}
```

- [ ] **Step 6: Commit**

```bash
git add frontend/apps/web/src/server/watchlists.ts frontend/apps/web/app/api/watchlists frontend/apps/web/tests/watchlists.test.ts
git commit -m "feat(web): watchlist read service — header, conditions with provenance, entries across membership types"
```

---

### Task 10: Quotes service + route (60s cache, per-symbol errors)

**Files:**
- Create: `apps/web/src/server/quotes.ts`, `apps/web/app/api/quotes/route.ts`
- Test: `apps/web/tests/quotes.test.ts`

**Interfaces:**
- Consumes: nothing beyond `fetch` (no engine-client reuse — `/quotes` on the engine takes `{symbols}` directly, per backend plan §4, so this calls the engine's `POST /quotes` with its own small wrapper rather than overloading Task 4's `screen`-shaped client).
- Produces: `getQuotes(symbols: string[], fetchFn?, now?: () => number): Promise<Record<string, { price: number | null; asOf: string | null; error: string | null }>>`. Caches each symbol's successful result in-process for 60 seconds (keyed by symbol); a cache hit skips the network call entirely; symbols are deduplicated before calling the engine.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/quotes.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { getQuotes, _resetQuoteCacheForTests } from "@/server/quotes";

beforeEach(() => _resetQuoteCacheForTests());

describe("getQuotes", () => {
  it("fetches uncached symbols from the engine", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ABC: { price: 101.5, as_of: "2026-10-02T09:15:00Z", error: null } }),
    });
    const result = await getQuotes(["ABC"], fetchFn as any, () => 0);
    expect(result.ABC).toEqual({ price: 101.5, asOf: "2026-10-02T09:15:00Z", error: null });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("serves a repeat request within 60 seconds from cache, without a second fetch", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ABC: { price: 101.5, as_of: "t", error: null } }) });
    await getQuotes(["ABC"], fetchFn as any, () => 1000);
    await getQuotes(["ABC"], fetchFn as any, () => 1000 + 59_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("refetches once the cache entry is older than 60 seconds", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ABC: { price: 101.5, as_of: "t", error: null } }) });
    await getQuotes(["ABC"], fetchFn as any, () => 0);
    await getQuotes(["ABC"], fetchFn as any, () => 61_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("surfaces a per-symbol error without failing the whole call", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ABC: { price: 10, as_of: "t", error: null }, XYZ: { price: null, as_of: null, error: "no data" } }),
    });
    const result = await getQuotes(["ABC", "XYZ"], fetchFn as any, () => 0);
    expect(result.XYZ.error).toBe("no data");
    expect(result.ABC.error).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- quotes.test`
Expected: FAIL — `Cannot find module '@/server/quotes'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/server/quotes.ts
import { ENGINE_BASE_URL, EngineError } from "@/server/engine/client";

type Quote = { price: number | null; asOf: string | null; error: string | null };

const CACHE_MS = 60_000;
let cache = new Map<string, { quote: Quote; fetchedAtMs: number }>();

export function _resetQuoteCacheForTests() {
  cache = new Map();
}

export async function getQuotes(
  symbols: string[],
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now
): Promise<Record<string, Quote>> {
  const unique = Array.from(new Set(symbols));
  const nowMs = now();
  const result: Record<string, Quote> = {};
  const toFetch: string[] = [];

  for (const symbol of unique) {
    const cached = cache.get(symbol);
    if (cached && nowMs - cached.fetchedAtMs < CACHE_MS) {
      result[symbol] = cached.quote;
    } else {
      toFetch.push(symbol);
    }
  }

  if (toFetch.length > 0) {
    const res = await fetchFn(`${ENGINE_BASE_URL}/quotes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbols: toFetch }),
    });
    const body = await res.json();
    if (!res.ok) throw new EngineError(res.status, body);
    for (const symbol of toFetch) {
      const raw = body[symbol] ?? { price: null, as_of: null, error: "not returned by engine" };
      const quote: Quote = { price: raw.price, asOf: raw.as_of, error: raw.error };
      cache.set(symbol, { quote, fetchedAtMs: nowMs });
      result[symbol] = quote;
    }
  }

  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w apps/web -- quotes.test`
Expected: PASS (4 tests)

- [ ] **Step 5: Write the route**

```ts
// apps/web/app/api/quotes/route.ts
import { getQuotes } from "@/server/quotes";
import { EngineError } from "@/server/engine/client";

export async function POST(req: Request) {
  const { symbols } = await req.json();
  try {
    const quotes = await getQuotes(symbols);
    return Response.json(quotes);
  } catch (err) {
    if (err instanceof EngineError) return Response.json(err.body, { status: err.status });
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add frontend/apps/web/src/server/quotes.ts frontend/apps/web/app/api/quotes frontend/apps/web/tests/quotes.test.ts
git commit -m "feat(web): quotes service — 60s cache, per-symbol errors, proxies engine POST /quotes"
```

---

### Task 11: New-prompt page — manual draft form

**Files:**
- Create: `apps/web/src/components/ConditionRow.tsx`, `apps/web/app/drafts/new/page.tsx`
- Test: `apps/web/tests/components/ConditionRow.test.tsx`

**Interfaces:**
- Produces: `ConditionRow({ condition, onChange, onRemove })` — one editable row for a single `Condition` (role/kind/name/op/params/value selects and inputs, all starting empty, no suggested values anywhere). `app/drafts/new/page.tsx` is a client component that: creates a draft on mount (`POST /api/drafts`), lets the user pick `structure`, add/remove condition rows, fill `selection_point`/`stop`/`risk_cap_pct`/`near_miss`/the liquidity question (three explicit choices: confirm ₹10 cr/week, a custom number, or "no liquidity filter" — exactly one of which must be chosen, none pre-selected), fill `hypothesis`/`killCriterion`, and offers "Dry run" (`POST .../dry-run`) and "Confirm and assign Prompt ID" (`POST .../confirm`, then navigates to `/watchlists/:watchlistId`). Confirm is disabled with a visible reason string until the gate passes client-side (mirrors, but does not replace, the server-side gate in Task 8).

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/tests/components/ConditionRow.test.tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConditionRow } from "@/components/ConditionRow";

const EMPTY_CONDITION = { id: "C1", role: "filter" as const, kind: "field" as const, name: "", params: {}, op: "", value: null };

describe("ConditionRow", () => {
  it("renders every field empty — no pre-filled value anywhere", () => {
    render(<ConditionRow condition={EMPTY_CONDITION} onChange={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByLabelText(/condition name/i)).toHaveValue("");
    expect(screen.getByLabelText(/operator/i)).toHaveValue("");
  });

  it("calls onChange with the updated condition when the name field changes", () => {
    const onChange = vi.fn();
    render(<ConditionRow condition={EMPTY_CONDITION} onChange={onChange} onRemove={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/condition name/i), { target: { value: "vstop" } });
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_CONDITION, name: "vstop" });
  });

  it("calls onRemove with the condition's id", () => {
    const onRemove = vi.fn();
    render(<ConditionRow condition={EMPTY_CONDITION} onChange={vi.fn()} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: /remove/i }));
    expect(onRemove).toHaveBeenCalledWith("C1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- ConditionRow`
Expected: FAIL — `Cannot find module '@/components/ConditionRow'`

- [ ] **Step 3: Write the implementation**

```tsx
// apps/web/src/components/ConditionRow.tsx
"use client";
import type { Condition } from "spec";

export function ConditionRow({
  condition,
  onChange,
  onRemove,
}: {
  condition: Condition;
  onChange: (next: Condition) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <fieldset>
      <legend>{condition.id}</legend>
      <label>
        Role
        <select
          aria-label="role"
          value={condition.role}
          onChange={(e) => onChange({ ...condition, role: e.target.value as Condition["role"] })}
        >
          <option value="filter">filter</option>
          <option value="event">event</option>
          <option value="stop">stop</option>
        </select>
      </label>
      <label>
        Kind
        <select
          aria-label="kind"
          value={condition.kind}
          onChange={(e) => onChange({ ...condition, kind: e.target.value as Condition["kind"] })}
        >
          <option value="field">field</option>
          <option value="indicator">indicator</option>
        </select>
      </label>
      <label>
        Condition name
        <input
          aria-label="condition name"
          value={condition.name}
          onChange={(e) => onChange({ ...condition, name: e.target.value })}
        />
      </label>
      <label>
        Operator
        <input aria-label="operator" value={condition.op} onChange={(e) => onChange({ ...condition, op: e.target.value })} />
      </label>
      <button type="button" aria-label={`remove condition ${condition.id}`} onClick={() => onRemove(condition.id)}>
        Remove
      </button>
    </fieldset>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w apps/web -- ConditionRow`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the page** (no automated test — this wires fully-tested pieces together via plain `fetch`; verified manually in Task 12's smoke check once both pages exist)

```tsx
// apps/web/app/drafts/new/page.tsx
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
```

- [ ] **Step 6: Commit**

```bash
git add frontend/apps/web/src/components/ConditionRow.tsx frontend/apps/web/app/drafts/new frontend/apps/web/tests/components/ConditionRow.test.tsx
git commit -m "feat(web): New prompt page — manual condition-row builder, liquidity question, confirm gate"
```

---

### Task 12: Watchlist page — header, prices bar, tabs, table, detail link; end-to-end smoke check

**Files:**
- Create: `apps/web/src/components/StatusChip.tsx`, `apps/web/src/components/WatchlistTable.tsx`, `apps/web/app/watchlists/[watchlistId]/page.tsx`
- Test: `apps/web/tests/components/WatchlistTable.test.tsx`

**Interfaces:**
- Produces: `StatusChip({ status })` — renders the text label for each of the nine `watchlist_entries.status` values (never color-only, frontend plan §6). `WatchlistTable({ entries, conditionNames })` — renders the `All` set of entries with one column per condition name passed in (dynamic columns, frontend plan §3.1) plus Stock/Status/Entry/Stop columns; filtering into the `Arm picks`/`Near miss` tabs is the caller's job (a plain `.filter()` on `membership`), so the table component itself only ever renders what it's given. `app/watchlists/[watchlistId]/page.tsx` fetches `GET /api/watchlists/:id`, shows the header (title, structure, hypothesis), the prompt's conditions with provenance, a tab selector (`All` / `Arm picks` / `Near miss`, with the risk-cap tab appearing only when `view.hasRiskCap`), the table, and a "Refresh prices" button that calls `POST /api/quotes` with the current entries' symbols.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/tests/components/WatchlistTable.test.tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { WatchlistTable } from "@/components/WatchlistTable";

const ENTRIES = [
  { entryId: 1, symbol: "FULL1", membership: "full_match", status: "pending_selection", entryPrice: null, stop: null, refPrice: null, condValues: { C1: 25000 }, failedIds: [] },
  { entryId: 2, symbol: "NEAR1", membership: "near_miss", status: "watching", entryPrice: null, stop: null, refPrice: 50.0, condValues: { C1: 9000 }, failedIds: ["C1"] },
];

describe("WatchlistTable", () => {
  it("renders one row per entry with a status chip that carries text, not color alone", () => {
    render(<WatchlistTable entries={ENTRIES} conditionNames={["C1"]} />);
    expect(screen.getByText("FULL1")).toBeInTheDocument();
    expect(screen.getByText("NEAR1")).toBeInTheDocument();
    expect(screen.getByText(/watching.*not graded/i)).toBeInTheDocument();
  });

  it("renders one column per condition name passed in, hiding columns that don't apply", () => {
    render(<WatchlistTable entries={ENTRIES} conditionNames={["C1"]} />);
    expect(screen.getAllByText("25000")).toHaveLength(1);
    expect(screen.getAllByText("9000")).toHaveLength(1);
  });

  it("renders an empty table without crashing when there are zero entries", () => {
    render(<WatchlistTable entries={[]} conditionNames={["C1"]} />);
    expect(screen.getByRole("table")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- WatchlistTable`
Expected: FAIL — `Cannot find module '@/components/WatchlistTable'`

- [ ] **Step 3: Write `StatusChip.tsx` and `WatchlistTable.tsx`**

```tsx
// apps/web/src/components/StatusChip.tsx
const LABEL: Record<string, string> = {
  pending_selection: "Selection pending",
  entered: "Entered",
  not_confirmed: "Not confirmed at open",
  no_point_data: "No point data",
  watching: "Watching · not graded",
  dropped_from_screen: "Dropped from screen",
  stopped_out: "Stopped out",
  removed_by_user: "Removed",
  closed: "Closed",
};

export function StatusChip({ status }: { status: string }) {
  return <span className="status-chip">{LABEL[status] ?? status}</span>;
}
```

```tsx
// apps/web/src/components/WatchlistTable.tsx
import { StatusChip } from "@/components/StatusChip";

type Entry = {
  entryId: number; symbol: string; membership: string; status: string;
  entryPrice: number | null; stop: number | null; refPrice: number | null;
  condValues: Record<string, unknown>; failedIds: string[];
};

export function WatchlistTable({ entries, conditionNames }: { entries: Entry[]; conditionNames: string[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Stock</th>
          <th>Status</th>
          {conditionNames.map((name) => (
            <th key={name}>{name}</th>
          ))}
          <th>Entry / Stop</th>
          <th>Since entry</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr key={e.entryId}>
            <td>{e.symbol}</td>
            <td><StatusChip status={e.status} /></td>
            {conditionNames.map((name) => (
              <td key={name}>{String(e.condValues[name] ?? "—")}</td>
            ))}
            <td>{e.entryPrice ?? "—"} / {e.stop ?? "—"}</td>
            <td>{e.membership === "full_match" ? (e.entryPrice ? "since entry" : "—") : e.refPrice ? "since ref" : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w apps/web -- WatchlistTable`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the page**

```tsx
// apps/web/app/watchlists/[watchlistId]/page.tsx
"use client";
import { useEffect, useState } from "react";
import { WatchlistTable } from "@/components/WatchlistTable";

type Tab = "all" | "full_match" | "near_miss";

export default function WatchlistPage({ params }: { params: { watchlistId: string } }) {
  const [view, setView] = useState<any>(null);
  const [tab, setTab] = useState<Tab>("all");
  const [pricesAsOf, setPricesAsOf] = useState<string | null>(null);

  async function load() {
    const res = await fetch(`/api/watchlists/${params.watchlistId}`);
    setView(await res.json());
  }

  async function refreshPrices(current: any) {
    const symbols = current.entries.map((e: any) => e.symbol);
    if (symbols.length === 0) return;
    await fetch("/api/quotes", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbols }),
    });
    setPricesAsOf(new Date().toISOString());
  }

  useEffect(() => {
    load();
  }, [params.watchlistId]);

  if (!view) return <p>Loading…</p>;

  const visibleEntries =
    tab === "all" ? view.entries : view.entries.filter((e: any) => e.membership === tab);

  return (
    <main>
      <h1>{view.title}</h1>
      <p>{view.structure} · Shadow arm · graded vs Control</p>
      <p>{view.hypothesis}</p>

      <section>
        <h2>Your conditions</h2>
        <ul>
          {view.conditions.map((c: any) => (
            <li key={c.condNo}>
              C{c.condNo}: {c.kind} {c.name} {c.op} {JSON.stringify(c.value)} — <em>{c.valueOrigin === "prompt" ? "from the prompt" : "your answer"}</em>
            </li>
          ))}
        </ul>
      </section>

      <p>
        Prices as of {pricesAsOf ?? "not yet fetched"} · Yahoo Finance · may be delayed{" "}
        <button type="button" onClick={() => refreshPrices(view)}>Refresh prices</button>
      </p>

      <nav>
        <button type="button" onClick={() => setTab("all")} aria-pressed={tab === "all"}>All</button>
        <button type="button" onClick={() => setTab("full_match")} aria-pressed={tab === "full_match"}>Arm picks</button>
        <button type="button" onClick={() => setTab("near_miss")} aria-pressed={tab === "near_miss"}>Near miss</button>
      </nav>

      <WatchlistTable entries={visibleEntries} conditionNames={view.conditions.map((c: any) => `C${c.condNo}`)} />
    </main>
  );
}
```

- [ ] **Step 6: Build check and manual smoke test**

Run: `npm run build -w apps/web`
Expected: builds with no type errors.

Then, with the Python engine running (`uvicorn engine.app:create_app --factory --port 8001` from the `prompt-screener-engine` worktree) and `npm run dev` from `frontend/`: open `/drafts/new`, pick `literal`, add one `field`/`mcap_cr`/`between` condition, answer liquidity "No liquidity filter", fill hypothesis/kill criterion, click "Confirm and assign Prompt ID", and confirm the browser navigates to `/watchlists/:id` showing the seeded entries. This manual step is **not** a substitute for the automated tests above — it is the one check that can't be hermetic, since it needs a live engine process, and is the task's acceptance criterion from backend plan §11 P1 ("Done when: You can confirm a prompt and open its watchlist with all membership types").

- [ ] **Step 7: Commit**

```bash
git add frontend/apps/web/src/components/StatusChip.tsx frontend/apps/web/src/components/WatchlistTable.tsx frontend/apps/web/app/watchlists frontend/apps/web/tests/components/WatchlistTable.test.tsx
git commit -m "feat(web): Watchlist page — header, conditions with provenance, prices bar, tabs, dynamic-column table"
```

---

## What Phase 1 deliberately leaves out

These are real gaps against the full v3.2 UI, each already assigned to a later phase by both plans' own phase tables — not oversights:

- **Prompt compiler / free-text reading** ("Read my prompt", `needs_input` questions derived from text, `source_phrases`, the unsupported-conditions red block) — frontend plan §7 P3, backend plan §11 P3.
- **Selection-point precision** (`POST /select`, holiday-aware EP, "Not confirmed at open" actually being computed rather than just displayable) and **arm registration / weekly grading** (`POST /arms/register`, `validate_prior`, the Validation card's real numbers) — backend plan §11 P2.
- **My prompts, version chain, Explore, Follow/Unfollow, Copy to my drafts, multi-user login** — frontend plan §7 P2/P4.
- **Detail panel, personal notes, "Remove from my watchlist"** — these touch `entry_events` and `watchlist_entries.user_note`, both reachable with the schema already in place, but are left for the plan that adds the detail route, to keep this plan's Task 12 to the table view the "Done when" bar requires.

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-10-05-prompt-screener-frontend.md`. Please review it — in particular the scope calls flagged in **Global Constraints** (dry runs never persisted in P1, confirm's seed run using `kind = 'catch_up'` as a one-off synchronous call rather than going through a job queue, and the nine-table migration subset) and **"What Phase 1 deliberately leaves out"** above.

Which execution approach would you prefer?

- **Subagent-driven** — a fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** — I implement every task myself in this session, then one fresh reviewer checks the whole branch at the end. Cheapest and fastest; no independent review until the end.

I'd lean toward **subagent-driven** here: Task 8 (confirm) is load-bearing for every later task — Tasks 9, 11, and 12 all depend on its exact table-writing behavior — and a mistake there (e.g. getting the `membership` → `status` mapping wrong, or the `in_forward_record` guard wrong) would silently corrupt every watchlist built on top of it, so it's worth a dedicated review before Task 9 starts rather than only at the end. But this is also a greenfield app with no production data at stake yet, so Native with a careful final review is a reasonable, cheaper choice if you'd rather move faster. Does the plan capture what you want, and which approach should we use? Also worth confirming before we start: should this happen in a brand-new worktree (mirroring how `prompt-screener-engine` was isolated), and is a Next.js/npm toolchain already available in this environment?
