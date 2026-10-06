# Prompt Screener — Frontend Phase 2 Implementation Plan (grading, versioning, My Prompts)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build frontend-plan §7 P2 — wire the already-implemented engine endpoints (`POST /select`, `POST /arms/register`, `POST /arms/{id}/retire`, `POST /validate`) into the Next.js app so a confirmed prompt's picks actually get an entry status and price, its arm is registered/retired, a week-over-week grading job can run, edits mint new versioned prompts, and the UI gains the "My prompts" screen, a real validation card, and an entry timeline.

**Architecture:** Same monorepo as Phase 1 (`frontend/packages/spec`, `frontend/apps/web`). No new processes: `select_entry`/`validate_prior`/`catch_up` are plain DB-injected service functions (same testing discipline as Phase 1 — in-memory `better-sqlite3`, injectable `fetchFn`, no real engine/network in tests), made idempotent by a new `jobs` table and invoked either synchronously right after `confirmDraft` (for the prompt's first run) or from a small CLI script a human/cron runs later (mirrors `scripts/weekly_selection_run.sh`'s role on the Python side — this is still "local, in-process" per backend plan D4, not a real worker).

**Tech Stack:** Same as Phase 1, plus `tsx` (devDependency, to run the new CLI script directly from TypeScript without a build step).

**Spec:** `docs/prompt-screener-frontend-plan.md` v3.2 §3.1 (validation card), §3.3 (My prompts, version chain), §7 P2; `docs/prompt-screener-backend-plan.md` v3.2 §5 (prompt IDs/versioning), §7 (jobs), §8 (`entry_events`, `validations`, `jobs` DDL); `docs/superpowers/plans/2026-10-05-prompt-screener-frontend.md` (Phase 1, already built — this plan modifies `confirm.ts` and extends `schema.ts`/migrations/`engine/client.ts` from it). Engine contract: read directly from the implemented code in the `prompt-screener-engine` worktree (`engine/app.py`, `engine/selection.py`, `engine/validation.py`, `engine/arms.py`) — **this plan consumes those exactly as implemented, not the backend-plan doc's §4 table, which predates them and has drifted** (e.g. the doc describes `POST /validate` as `{prompt_id, run_id}`; the real endpoint takes `{prompt_id, spec, as_of, picks, graded_weeks_so_far}` — the real signature is what this plan calls).

## Global Constraints

- **Only the already-implemented engine endpoints are consumed, exactly as implemented (same rule Phase 1 used for `/screen`).** `POST /select` returns `{entered, not_confirmed, no_point_data, watching}`, each a list of candidates carrying the original `/screen` candidate fields plus `entry_price` (entered/not_confirmed) or `ref_price` (watching) or `reason` (no_point_data). `POST /arms/register` takes `{prompt_id, spec}`. `POST /arms/{prompt_id}/retire` takes no body. `POST /validate` takes `{prompt_id, spec, as_of, picks, graded_weeks_so_far}` where each pick is `{ticker, entry_price, sl}` (lowercase keys — `engine/validation.py`'s `normalized` step reads `p["entry_price"]`/`p["sl"]` directly) and returns `{graded_weeks, maturity, rows}`.
- **`control_ew_return` stays NULL in this plan.** Control's own forward-test return series isn't wired into this app yet — flagged explicitly rather than guessed or faked. The `validations` row still gets `ew_return`/`hit_rate` from the engine's own graded rows.
- **No real scheduler.** `select_entry`, `validate_prior` and `catch_up` are plain functions, idempotent via the new `jobs` table (`UNIQUE(type, prompt_id, as_of)`, backend plan §8.4, verbatim). A CLI script invokes them; nothing in this plan starts a background worker or a cron job itself (D4).
- **Confirm's post-commit engine calls never roll back an already-committed prompt.** `confirmDraft` still returns `{promptId, watchlistId}` even if the engine is unreachable for `registerArm`/the first `select_entry`; it adds a `selectionWarning: string | null` field instead of throwing. The DB-level guarantees from Phase 1 (D6 `value_origin` CHECK, D8 shadow-never-graded CHECKs) are untouched and still enforced regardless of whether selection succeeded.
- **D8 still holds.** A `watching` outcome from `/select` never gets `entry_price` or `in_forward_record = 1`. `run_results`/`watchlist_entries`'s P1 CHECKs enforce this at the DB layer already; this plan's code must not even attempt it (Review Focus, Task 5).
- **Editing or retiring a confirmed prompt never mutates its row (backend plan §5).** Edit always produces a new draft, confirming it always mints a new `prompt_id` with `parent_prompt_id` set and `version` incremented; the old prompt becomes `superseded` (edit) or `retired` (direct retire) and keeps every record it already has.
- **Ids stay numeric (D11), traceability stays enforced (D6)** — unaffected by this plan; no new path writes a condition value with `value_origin = 'default'`.
- **Routes stay thin wiring over a service function (Phase 1's own rule, §100 of the Phase 1 plan)** — every new route's logic is tested at the service level; only one wiring test per route family is added at the HTTP layer.

## Review Focus

- **The engine is unreachable when `confirmDraft` calls `registerArm`/`select_entry` right after committing.** Expected: the prompt and watchlist still exist, `confirmDraft` returns normally with `selectionWarning` set to a message, and nothing throws out of the route. Covered in Task 5.
- **`runSelectEntry` on a run where every candidate ends up `watching`.** Expected: no attempt to write `entry_price`/`in_forward_record`, the DB CHECKs are never exercised because the code path never tries, and the function returns normally with zero `entered` events. Covered in Task 5.
- **`runCatchUp` (or any job) is invoked twice for the exact same `(type, prompt_id, as_of)`.** Expected: the second call is a no-op — it sees the `jobs` row already `done` and returns without calling the engine again or writing a second `runs`/`validations` row. Covered in Task 4 and Task 7.
- **Editing a prompt that is already `superseded` or `retired`.** Expected: `createEditDraft` throws a clear error (`"prompt N is already superseded"` / `"...retired"`), not a silently-created second edit draft or a broken version chain with two prompts claiming the same `parent_prompt_id` at the same version number. Covered in Task 9.
- **`runValidatePrior` is called before 13 graded weeks exist (`graded_weeks_so_far < 13`).** Expected: it returns `{maturity: "not_first_look", rows: []}` from the engine and writes **nothing** to `validations` — the watchlist's validation card still renders, showing "graded week N of 13" from `graded_weeks` alone, never a crash on an empty `rows` array. Covered in Task 6 and Task 13.

---

## File Structure

```
frontend/apps/web/
  src/server/db/
    migrate.ts                                  (NEW — applyMigrations(raw), replaces the single-file logic in client.ts/test-db.ts)
    migrations/0002_jobs_and_grading.sql         (NEW — entry_events, validations, jobs — verbatim backend plan §8.4 subset)
    test-db.ts                                   (MODIFY — delegates to applyMigrations)
    client.ts                                    (MODIFY — delegates to applyMigrations)
    schema.ts                                    (MODIFY — add entryEvents, validations, jobs drizzle tables)
  src/server/engine/
    client.ts                                    (MODIFY — add selectCandidates, registerArm, retireArm, validateArm)
  src/server/
    weeklyScreen.ts                               (NEW — runWeeklyScreen: the screen-and-seed logic extracted from confirm.ts, generalised to every watchlist following a prompt)
    confirm.ts                                    (MODIFY — delegates seeding to runWeeklyScreen; adds post-commit registerArm + runSelectEntry; adds the edit/versioning path)
    jobs.ts                                       (NEW — withJob idempotency wrapper over the jobs table)
    selectEntry.ts                                (NEW — runSelectEntry)
    validatePrior.ts                              (NEW — runValidatePrior)
    catchUp.ts                                    (NEW — runCatchUp)
    prompts.ts                                    (NEW — createEditDraft, retirePrompt, listPrompts)
    validations.ts                                (NEW — getValidationSummary)
    entryDetail.ts                                (NEW — getEntryDetail)
  scripts/
    run-weekly-jobs.ts                            (NEW — CLI: catch-up every active prompt)
  app/
    api/prompts/route.ts                          (NEW — GET)
    api/prompts/[promptId]/edit/route.ts          (NEW — POST)
    api/prompts/[promptId]/retire/route.ts        (NEW — POST)
    api/watchlists/[watchlistId]/entries/[entryId]/route.ts  (NEW — GET)
    prompts/page.tsx                              (NEW — My prompts)
    watchlists/[watchlistId]/page.tsx             (MODIFY — adds ValidationCard, entry detail link)
  src/components/
    ValidationCard.tsx                            (NEW)
    EntryTimeline.tsx                              (NEW)
    VersionChain.tsx                               (NEW)
  tests/
    migrate.test.ts
    engine-client-p2.test.ts
    weeklyScreen.test.ts
    jobs.test.ts
    selectEntry.test.ts
    validatePrior.test.ts
    catchUp.test.ts
    prompts.test.ts
    confirm-versioning.test.ts
    api-wiring-p2.test.ts
    components/ValidationCard.test.tsx
    components/VersionChain.test.tsx
```

---

### Task 1: Migration runner + `0002_jobs_and_grading.sql` (`entry_events`, `validations`, `jobs`)

**Files:**
- Create: `apps/web/src/server/db/migrate.ts`, `apps/web/src/server/db/migrations/0002_jobs_and_grading.sql`
- Modify: `apps/web/src/server/db/test-db.ts`, `apps/web/src/server/db/client.ts`, `apps/web/src/server/db/schema.ts`
- Test: `apps/web/tests/migrate.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `applyMigrations(raw: Database.Database): void` — applies every `NNNN_*.sql` file under `migrations/` not yet recorded in a new `_migrations(filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL)` bookkeeping table, in filename sort order. `createTestDb()` and `db()` both call it instead of reading `0001_init.sql` directly. `schema.ts` gains `entryEvents`, `validations`, `jobs` drizzle table defs (query-builder shapes only — constraints live in the SQL, same convention as every other table in this file).

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/migrate.test.ts
import { describe, expect, it } from "vitest";
import { createTestDb } from "@/server/db/test-db";

describe("createTestDb / applyMigrations", () => {
  it("applies both 0001 and 0002, and is idempotent on a second call", () => {
    const raw = createTestDb();
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toContain("users");
    expect(tables).toContain("entry_events");
    expect(tables).toContain("validations");
    expect(tables).toContain("jobs");

    // Re-applying must not re-run 0001/0002 (which would try to CREATE TABLE
    // users again and throw) — applyMigrations is exported for this test to
    // call a second time directly against the same handle.
    const { applyMigrations } = require("@/server/db/migrate");
    expect(() => applyMigrations(raw)).not.toThrow();
  });

  it("rejects a jobs row with a status outside the enum", () => {
    const raw = createTestDb();
    expect(() =>
      raw.prepare("INSERT INTO jobs (type, status, created_at) VALUES ('select_entry', 'bogus', '2026-01-01')").run()
    ).toThrow();
  });

  it("enforces UNIQUE(type, prompt_id, as_of) on jobs", () => {
    const raw = createTestDb();
    raw.prepare("INSERT INTO jobs (type, prompt_id, as_of, status, created_at) VALUES ('select_entry', 1, '2026-10-02', 'done', '2026-01-01')").run();
    expect(() =>
      raw.prepare("INSERT INTO jobs (type, prompt_id, as_of, status, created_at) VALUES ('select_entry', 1, '2026-10-02', 'queued', '2026-01-01')").run()
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- migrate.test`
Expected: FAIL — `Cannot find module '@/server/db/migrate'`

- [ ] **Step 3: Write `migrations/0002_jobs_and_grading.sql`** (verbatim backend plan §8.4 subset)

```sql
-- apps/web/src/server/db/migrations/0002_jobs_and_grading.sql
PRAGMA foreign_keys = ON;

CREATE TABLE entry_events (
  event_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id   INTEGER NOT NULL REFERENCES watchlist_entries(entry_id),
  run_id     INTEGER REFERENCES runs(run_id),
  type       TEXT NOT NULL,
  from_value TEXT, to_value TEXT,
  at         TEXT NOT NULL
);
CREATE INDEX ix_events_entry ON entry_events(entry_id, at);

CREATE TABLE validations (
  run_id            INTEGER NOT NULL REFERENCES runs(run_id),
  horizon_w         INTEGER NOT NULL CHECK (horizon_w IN (1,2,3)),
  n                 INTEGER NOT NULL,
  ew_return         REAL, control_ew_return REAL, hit_rate REAL,
  computed_at       TEXT NOT NULL,
  PRIMARY KEY (run_id, horizon_w)
);

CREATE TABLE jobs (
  job_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  prompt_id  INTEGER REFERENCES prompts(prompt_id),
  as_of      TEXT,
  status     TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','blocked_stale_data')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  error      TEXT, created_at TEXT NOT NULL, finished_at TEXT,
  UNIQUE (type, prompt_id, as_of)
);
```

- [ ] **Step 4: Write `migrate.ts`**

```ts
// apps/web/src/server/db/migrate.ts
import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

// Same reasoning as client.ts's existing MIGRATION_PATH comment: __dirname
// doesn't survive Next.js's server bundling, so anchor to process.cwd()
// (apps/web, under next dev/start and under vitest alike).
const MIGRATIONS_DIR = path.join(process.cwd(), "src", "server", "db", "migrations");

export function applyMigrations(raw: Database.Database): void {
  raw.exec(`CREATE TABLE IF NOT EXISTS _migrations (filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set(
    (raw.prepare("SELECT filename FROM _migrations").all() as { filename: string }[]).map((r) => r.filename)
  );
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
    raw.exec(sql);
    raw.prepare("INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)").run(file, new Date().toISOString());
  }
}
```

- [ ] **Step 5: Rewrite `test-db.ts` and `client.ts` to delegate**

```ts
// apps/web/src/server/db/test-db.ts
import Database from "better-sqlite3";
import { applyMigrations } from "./migrate";

export function createTestDb(): Database.Database {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  applyMigrations(raw);
  return raw;
}
```

```ts
// apps/web/src/server/db/client.ts
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { ensureOwnerUser } from "./seed";
import { applyMigrations } from "./migrate";

const DB_PATH = path.join(process.cwd(), "data", "app.db");

let instance: Database.Database | null = null;

export function db(): Database.Database {
  if (instance) return instance;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const raw = new Database(DB_PATH);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  applyMigrations(raw);
  ensureOwnerUser(raw);
  instance = raw;
  return instance;
}
```

- [ ] **Step 6: Add the three drizzle table defs to `schema.ts`**

```ts
// apps/web/src/server/db/schema.ts — append
export const entryEvents = sqliteTable("entry_events", {
  eventId: integer("event_id").primaryKey({ autoIncrement: true }),
  entryId: integer("entry_id").notNull(),
  runId: integer("run_id"),
  type: text("type").notNull(),
  fromValue: text("from_value"),
  toValue: text("to_value"),
  at: text("at").notNull(),
});

export const validations = sqliteTable("validations", {
  runId: integer("run_id").notNull(),
  horizonW: integer("horizon_w").notNull(),
  n: integer("n").notNull(),
  ewReturn: real("ew_return"),
  controlEwReturn: real("control_ew_return"),
  hitRate: real("hit_rate"),
  computedAt: text("computed_at").notNull(),
});

export const jobs = sqliteTable("jobs", {
  jobId: integer("job_id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(),
  promptId: integer("prompt_id"),
  asOf: text("as_of"),
  status: text("status").notNull(),
  attempts: integer("attempts").notNull(),
  error: text("error"),
  createdAt: text("created_at").notNull(),
  finishedAt: text("finished_at"),
});
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm run test -w apps/web -- migrate.test`
Expected: PASS (3 tests). Also re-run the full suite (`npm run test -w apps/web`) to confirm Phase 1's `db.test.ts` still passes unchanged against the new migration runner.

- [ ] **Step 8: Commit**

```bash
git add frontend/apps/web/src/server/db frontend/apps/web/tests/migrate.test.ts
git commit -m "feat(web): migration runner + entry_events/validations/jobs tables (0002)"
```

---

### Task 2: Engine client additions — `selectCandidates`, `registerArm`, `retireArm`, `validateArm`

**Files:**
- Modify: `apps/web/src/server/engine/client.ts`
- Test: `apps/web/tests/engine-client-p2.test.ts`

**Interfaces:**
- Consumes: `call`, `EngineError`, `ENGINE_BASE_URL` from Phase 1's `client.ts` (unchanged).
- Produces: `selectCandidates(spec: ScreenSpec, asOf: string, promptId: number | null, runKind: "scheduled" | "catch_up" | "dry_run", fetchFn?)` → `SelectResult`; `registerArm(promptId: number, spec: ScreenSpec, fetchFn?)` → `{prompt_id: number; status: string}`; `retireArm(promptId: number, fetchFn?)` → `{prompt_id: number; status: string}`; `validateArm(promptId: number, spec: ScreenSpec, asOf: string, picks: ValidatePick[], gradedWeeksSoFar: number, fetchFn?)` → `ValidateResult`. Types `SelectCandidate`, `SelectResult`, `ValidatePick`, `ValidateRow`, `ValidateResult` are exported for later tasks.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/engine-client-p2.test.ts
import { describe, expect, it, vi } from "vitest";
import { registerArm, retireArm, selectCandidates, validateArm } from "@/server/engine/client";

function fakeFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
}

const SPEC = {
  spec_version: 4, structure: "literal" as const, timeframe: "1W" as const,
  selection_point: { session_of_week: 1, at: "open" as const },
  conditions: [], stop: null, risk_cap_pct: null, near_miss: null,
};

describe("selectCandidates", () => {
  it("posts spec/as_of/prompt_id/run_kind and returns the four membership buckets", async () => {
    const fetchFn = fakeFetch(200, { entered: [{ ticker: "A", entry_price: 101 }], not_confirmed: [], no_point_data: [], watching: [] });
    const result = await selectCandidates(SPEC, "2026-10-02", 7, "scheduled", fetchFn as any);
    expect(result.entered).toHaveLength(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8001/select");
    expect(JSON.parse(init.body)).toEqual({ spec: SPEC, as_of: "2026-10-02", prompt_id: 7, run_kind: "scheduled" });
  });
});

describe("registerArm / retireArm", () => {
  it("registerArm posts {prompt_id, spec} to /arms/register", async () => {
    const fetchFn = fakeFetch(200, { prompt_id: 7, status: "active" });
    const result = await registerArm(7, SPEC, fetchFn as any);
    expect(result.status).toBe("active");
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8001/arms/register");
    expect(JSON.parse(init.body)).toEqual({ prompt_id: 7, spec: SPEC });
  });

  it("retireArm posts to /arms/{id}/retire with no body", async () => {
    const fetchFn = fakeFetch(200, { prompt_id: 7, status: "retired" });
    const result = await retireArm(7, fetchFn as any);
    expect(result.status).toBe("retired");
    const [url] = fetchFn.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8001/arms/7/retire");
  });
});

describe("validateArm", () => {
  it("posts prompt_id/spec/as_of/picks/graded_weeks_so_far, returns graded_weeks/maturity/rows", async () => {
    const fetchFn = fakeFetch(200, { graded_weeks: 13, maturity: "first_look", rows: [{ ticker: "A", horizon_weeks: 1, status: "graded", r_Nw: 2.5 }] });
    const result = await validateArm(7, SPEC, "2026-10-02", [{ ticker: "A", entry_price: 100, sl: 95 }], 13, fetchFn as any);
    expect(result.maturity).toBe("first_look");
    expect(result.rows).toHaveLength(1);
    const [, init] = fetchFn.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      prompt_id: 7, spec: SPEC, as_of: "2026-10-02",
      picks: [{ ticker: "A", entry_price: 100, sl: 95 }], graded_weeks_so_far: 13,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- engine-client-p2`
Expected: FAIL — the four names don't exist yet.

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/server/engine/client.ts — append
export type SelectCandidate = {
  ticker: string;
  membership: "full_match" | "near_miss" | "rejected_risk_cap";
  values: Record<string, unknown>;
  failed_ids: string[];
  ep: number | null;
  sl: number | null;
  r: number | null;
  entry_price?: number;
  ref_price?: number | null;
  reason?: string;
};

export type SelectResult = {
  entered: SelectCandidate[];
  not_confirmed: SelectCandidate[];
  no_point_data: SelectCandidate[];
  watching: SelectCandidate[];
};

export async function selectCandidates(
  spec: ScreenSpec,
  asOf: string,
  promptId: number | null,
  runKind: "scheduled" | "catch_up" | "dry_run",
  fetchFn: FetchFn = fetch
): Promise<SelectResult> {
  return call(
    "/select",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spec, as_of: asOf, prompt_id: promptId, run_kind: runKind }),
    },
    fetchFn
  ) as Promise<SelectResult>;
}

export async function registerArm(promptId: number, spec: ScreenSpec, fetchFn: FetchFn = fetch) {
  return call(
    "/arms/register",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt_id: promptId, spec }) },
    fetchFn
  ) as Promise<{ prompt_id: number; status: string }>;
}

export async function retireArm(promptId: number, fetchFn: FetchFn = fetch) {
  return call(`/arms/${promptId}/retire`, { method: "POST" }, fetchFn) as Promise<{ prompt_id: number; status: string }>;
}

export type ValidatePick = { ticker: string; entry_price: number | null; sl: number | null };

export type ValidateRow = {
  ticker: string;
  signal_week_start: string;
  horizon_weeks: number;
  status: "graded" | "pending" | "not_gradable_weekly_downtrend";
  buy_price: number | null;
  r_Nw: number | null;
};

export type ValidateResult = { graded_weeks: number; maturity: "not_first_look" | "first_look" | "real_read"; rows: ValidateRow[] };

export async function validateArm(
  promptId: number,
  spec: ScreenSpec,
  asOf: string,
  picks: ValidatePick[],
  gradedWeeksSoFar: number,
  fetchFn: FetchFn = fetch
): Promise<ValidateResult> {
  return call(
    "/validate",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt_id: promptId, spec, as_of: asOf, picks, graded_weeks_so_far: gradedWeeksSoFar }),
    },
    fetchFn
  ) as Promise<ValidateResult>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w apps/web -- engine-client-p2`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/src/server/engine/client.ts frontend/apps/web/tests/engine-client-p2.test.ts
git commit -m "feat(web): engine client — selectCandidates/registerArm/retireArm/validateArm"
```

---

### Task 3: `weeklyScreen.ts` — extract and generalise confirm's screen-and-seed logic

**Files:**
- Create: `apps/web/src/server/weeklyScreen.ts`
- Modify: `apps/web/src/server/confirm.ts`
- Test: `apps/web/tests/weeklyScreen.test.ts`

**Interfaces:**
- Consumes: `screen` from `@/server/engine/client` (Phase 1); `prompts`/`watchlists`/`runs`/`symbols`/`run_results`/`watchlist_entries`/`entry_events` tables.
- Produces: `runWeeklyScreen(raw: Database.Database, { promptId, asOf, kind }: { promptId: number; asOf: string; kind: "scheduled" | "catch_up" }, fetchFn?): Promise<{ runId: number }>`. Unlike Phase 1's inline confirm logic (which only ever had one watchlist to fill), this seeds/updates **every** watchlist currently following `promptId` (backend plan §8.3): a new candidate becomes a new entry; an existing open entry for the same symbol gets `last_run_id` and `membership` updated (logging an `entry_events` row if membership changed); an open entry no longer in this run's candidates becomes `dropped_from_screen` (logging an event). `confirmDraft` is modified to create the prompt + first watchlist + `prompt_conditions`, then call `runWeeklyScreen` for the seeding step it used to do inline — Task 3 is a pure refactor with no observable behavior change for the single-watchlist case, so **Phase 1's existing `tests/confirm.test.ts` must still pass unmodified** after this task.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/weeklyScreen.test.ts
import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { runWeeklyScreen } from "@/server/weeklyScreen";

const SPEC = {
  spec_version: 4, structure: "literal" as const, timeframe: "1W" as const,
  selection_point: { session_of_week: 1, at: "open" as const },
  conditions: [{ id: "idMcap", role: "filter" as const, kind: "field" as const, name: "mcap_cr", params: {}, op: "between", value: [10000, 50000] }],
  stop: null, risk_cap_pct: null, near_miss: null,
};

function seedPromptWithTwoWatchlists(raw: ReturnType<typeof createTestDb>) {
  const ownerId = ensureOwnerUser(raw);
  const now = "2026-10-01T00:00:00.000Z";
  raw.prepare(`INSERT INTO users (user_id, display_name, role, status, created_at) VALUES (2, 'Second', 'member', 'active', ?)`).run(now);
  raw.prepare(`INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (1, ?, 'x', 'confirmed', ?, ?)`).run(ownerId, now, now);
  raw.prepare(
    `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, confirmed_at)
     VALUES (1, ?, 1, 'Prompt 1', 'x', 'literal', ?, 'h', 'confirmed', 1, 'hyp', 'kill', ?)`
  ).run(ownerId, JSON.stringify(SPEC), now);
  raw.prepare(`INSERT INTO prompt_conditions (prompt_id, cond_no, role, kind, name, op, value_origin) VALUES (1, 1, 'filter', 'field', 'mcap_cr', 'between', 'user_answer')`).run();
  raw.prepare(`INSERT INTO watchlists (watchlist_id, user_id, prompt_id, name, created_at) VALUES (1, ?, 1, 'owner wl', ?)`).run(ownerId, now);
  raw.prepare(`INSERT INTO watchlists (watchlist_id, user_id, prompt_id, name, created_at) VALUES (2, 2, 1, 'follower wl', ?)`).run(now);
  return { ownerId };
}

function fakeScreenFetch(candidates: any[]) {
  return vi.fn().mockResolvedValue({
    ok: true,
    text: async () => JSON.stringify({ candidates, applied_steps: [], funnel: [], sector_view: [] }),
  });
}

describe("runWeeklyScreen", () => {
  it("seeds a new candidate into every watchlist following the prompt", async () => {
    const raw = createTestDb();
    seedPromptWithTwoWatchlists(raw);
    const fetchFn = fakeScreenFetch([{ ticker: "FULL1", membership: "full_match", values: { idMcap: 25000 }, failed_ids: [], ep: 100, sl: 95, r: 0.05 }]);

    const { runId } = await runWeeklyScreen(raw, { promptId: 1, asOf: "2026-10-02", kind: "scheduled" }, fetchFn as any);
    expect(runId).toBeGreaterThan(0);

    const entries = raw.prepare("SELECT watchlist_id, symbol, status FROM watchlist_entries ORDER BY watchlist_id").all() as any[];
    expect(entries).toEqual([
      { watchlist_id: 1, symbol: "FULL1", status: "pending_selection" },
      { watchlist_id: 2, symbol: "FULL1", status: "pending_selection" },
    ]);
  });

  it("drops an open entry no longer present in this run's candidates, and logs the event", async () => {
    const raw = createTestDb();
    seedPromptWithTwoWatchlists(raw);
    await runWeeklyScreen(raw, { promptId: 1, asOf: "2026-10-02", kind: "scheduled" }, fakeScreenFetch([{ ticker: "FULL1", membership: "full_match", values: {}, failed_ids: [], ep: 100, sl: 95, r: 0.05 }]) as any);

    await runWeeklyScreen(raw, { promptId: 1, asOf: "2026-10-09", kind: "scheduled" }, fakeScreenFetch([]) as any);

    const entry = raw.prepare("SELECT status FROM watchlist_entries WHERE watchlist_id = 1 AND symbol = 'FULL1'").get() as any;
    expect(entry.status).toBe("dropped_from_screen");
    const events = raw.prepare("SELECT type, to_value FROM entry_events").all() as any[];
    expect(events.some((e) => e.type === "dropped_from_screen" && e.to_value === "dropped_from_screen")).toBe(true);
  });

  it("updates an existing open entry's membership (near_miss -> full_match) instead of creating a duplicate", async () => {
    const raw = createTestDb();
    seedPromptWithTwoWatchlists(raw);
    await runWeeklyScreen(raw, { promptId: 1, asOf: "2026-10-02", kind: "scheduled" }, fakeScreenFetch([{ ticker: "X", membership: "near_miss", values: {}, failed_ids: ["idMcap"], ep: 10, sl: null, r: null }]) as any);

    await runWeeklyScreen(raw, { promptId: 1, asOf: "2026-10-09", kind: "scheduled" }, fakeScreenFetch([{ ticker: "X", membership: "full_match", values: {}, failed_ids: [], ep: 11, sl: 10, r: 0.1 }]) as any);

    const rows = raw.prepare("SELECT membership FROM watchlist_entries WHERE watchlist_id = 1 AND symbol = 'X'").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].membership).toBe("full_match");
  });

  it("handles zero candidates and zero watchlists without crashing", async () => {
    const raw = createTestDb();
    const ownerId = ensureOwnerUser(raw);
    const now = new Date().toISOString();
    raw.prepare(`INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (1, ?, 'x', 'confirmed', ?, ?)`).run(ownerId, now, now);
    raw.prepare(
      `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, confirmed_at)
       VALUES (1, ?, 1, 'Prompt 1', 'x', 'literal', ?, 'h', 'confirmed', 1, 'hyp', 'kill', ?)`
    ).run(ownerId, JSON.stringify(SPEC), now);
    const { runId } = await runWeeklyScreen(raw, { promptId: 1, asOf: "2026-10-02", kind: "scheduled" }, fakeScreenFetch([]) as any);
    expect(runId).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- weeklyScreen.test`
Expected: FAIL — `Cannot find module '@/server/weeklyScreen'`

- [ ] **Step 3: Write `weeklyScreen.ts`**

```ts
// apps/web/src/server/weeklyScreen.ts
import type Database from "better-sqlite3";
import { screen } from "@/server/engine/client";

function statusFor(membership: string): string {
  return membership === "full_match" ? "pending_selection" : "watching";
}

function remapKeysToCondNo(values: Record<string, unknown>, idToCondNo: Record<string, number>) {
  const out: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(values)) {
    const condNo = idToCondNo[id];
    if (condNo !== undefined) out[`C${condNo}`] = value;
  }
  return out;
}

function remapIdsToCondNo(ids: string[], idToCondNo: Record<string, number>): string[] {
  return ids.filter((id) => idToCondNo[id] !== undefined).map((id) => `C${idToCondNo[id]}`);
}

const OPEN_STATUSES = ["pending_selection", "entered", "not_confirmed", "no_point_data", "watching"];

export async function runWeeklyScreen(
  raw: Database.Database,
  { promptId, asOf, kind }: { promptId: number; asOf: string; kind: "scheduled" | "catch_up" },
  fetchFn?: typeof fetch
): Promise<{ runId: number }> {
  const prompt = raw.prepare("SELECT * FROM prompts WHERE prompt_id = ?").get(promptId) as any;
  if (!prompt) throw new Error(`prompt ${promptId} not found`);
  const spec = JSON.parse(prompt.spec_json);

  const idToCondNo: Record<string, number> = {};
  (raw.prepare("SELECT cond_no, name FROM prompt_conditions WHERE prompt_id = ? ORDER BY cond_no").all(promptId) as any[]).forEach((row, i) => {
    // The engine's own condition.id (e.g. "idMcap") is only known from the
    // spec, not from prompt_conditions (which stores name/cond_no, not the
    // original id string) — spec.conditions is written in the same cond_no
    // order at confirm time (Task 8, Phase 1), so zipping by index is exact.
    idToCondNo[spec.conditions[i].id] = row.cond_no;
  });

  const screenResult = await screen(spec, asOf, fetchFn);
  const now = new Date().toISOString();

  const txn = raw.transaction(() => {
    const runInfo = raw
      .prepare(
        `INSERT INTO runs (prompt_id, as_of, kind, status, applied_steps_json, funnel_json, finished_at)
         VALUES (?, ?, ?, 'done', ?, ?, ?)`
      )
      .run(promptId, asOf, kind, JSON.stringify(screenResult.applied_steps), JSON.stringify(screenResult.funnel), now);
    const runId = Number(runInfo.lastInsertRowid);

    const insertSymbol = raw.prepare(`INSERT OR IGNORE INTO symbols (symbol, active) VALUES (?, 1)`);
    const insertRunResult = raw.prepare(
      `INSERT INTO run_results
         (run_id, symbol, membership, in_forward_record, failed_conds_json, cond_json, metrics_json,
          ep, sl, ref_price, confidence, entry_status)
       VALUES (?, ?, ?, 0, ?, ?, NULL, ?, ?, ?, NULL, ?)`
    );
    const watchlistIds = (raw.prepare("SELECT watchlist_id FROM watchlists WHERE prompt_id = ? AND archived_at IS NULL").all(promptId) as { watchlist_id: number }[]).map((r) => r.watchlist_id);

    const selectOpenEntry = raw.prepare(
      `SELECT entry_id, membership, status FROM watchlist_entries WHERE watchlist_id = ? AND symbol = ? AND status IN (${OPEN_STATUSES.map(() => "?").join(",")})`
    );
    const insertEntry = raw.prepare(
      `INSERT INTO watchlist_entries (watchlist_id, symbol, first_run_id, last_run_id, membership, status, ref_price, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const updateEntryMembership = raw.prepare(
      `UPDATE watchlist_entries SET last_run_id = ?, membership = ?, updated_at = ? WHERE entry_id = ?`
    );
    const dropEntry = raw.prepare(
      `UPDATE watchlist_entries SET status = 'dropped_from_screen', last_run_id = ?, updated_at = ? WHERE entry_id = ?`
    );
    const insertEvent = raw.prepare(
      `INSERT INTO entry_events (entry_id, run_id, type, from_value, to_value, at) VALUES (?, ?, ?, ?, ?, ?)`
    );

    const seenSymbols = new Set<string>();
    for (const candidate of screenResult.candidates) {
      seenSymbols.add(candidate.ticker);
      insertSymbol.run(candidate.ticker);

      const entryStatus = statusFor(candidate.membership);
      const condJson = remapKeysToCondNo(candidate.values, idToCondNo);
      const failedCondsJson = remapIdsToCondNo(candidate.failed_ids, idToCondNo);

      insertRunResult.run(
        runId, candidate.ticker, candidate.membership, JSON.stringify(failedCondsJson), JSON.stringify(condJson),
        candidate.membership === "full_match" ? candidate.ep : null,
        candidate.membership === "full_match" ? candidate.sl : null,
        candidate.membership === "full_match" ? null : candidate.ep,
        entryStatus
      );

      for (const watchlistId of watchlistIds) {
        const existing = selectOpenEntry.get(watchlistId, candidate.ticker, ...OPEN_STATUSES) as any;
        if (!existing) {
          insertEntry.run(watchlistId, candidate.ticker, runId, runId, candidate.membership, entryStatus,
            candidate.membership === "full_match" ? null : candidate.ep, now, now);
        } else {
          if (existing.membership !== candidate.membership) {
            insertEvent.run(existing.entry_id, runId, "membership_changed", existing.membership, candidate.membership, now);
          }
          updateEntryMembership.run(runId, candidate.membership, now, existing.entry_id);
        }
      }
    }

    // Open entries not re-seen this run: dropped, per watchlist.
    for (const watchlistId of watchlistIds) {
      const openEntries = raw
        .prepare(`SELECT entry_id, symbol, status FROM watchlist_entries WHERE watchlist_id = ? AND status IN (${OPEN_STATUSES.map(() => "?").join(",")})`)
        .all(watchlistId, ...OPEN_STATUSES) as { entry_id: number; symbol: string; status: string }[];
      for (const entry of openEntries) {
        if (!seenSymbols.has(entry.symbol)) {
          dropEntry.run(runId, now, entry.entry_id);
          insertEvent.run(entry.entry_id, runId, "dropped_from_screen", entry.status, "dropped_from_screen", now);
        }
      }
    }

    return runId;
  });

  return { runId: txn() };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w apps/web -- weeklyScreen.test`
Expected: PASS (4 tests)

- [ ] **Step 5: Refactor `confirm.ts` to delegate to `runWeeklyScreen`**

```ts
// apps/web/src/server/confirm.ts
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { getDraft } from "@/server/drafts";
import { runWeeklyScreen } from "@/server/weeklyScreen";

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

  const existingPrompt = raw
    .prepare("SELECT prompt_id FROM prompts WHERE owner_user_id = ? AND spec_hash = ? AND status = 'confirmed'")
    .get(draft.userId, specHash) as { prompt_id: number } | undefined;
  if (existingPrompt) {
    throw new Error(
      `you already have a confirmed prompt with these exact conditions (Prompt ${existingPrompt.prompt_id})`
    );
  }

  const now = new Date().toISOString();
  const createPromptAndWatchlist = raw.transaction(() => {
    let promptInfo;
    try {
      promptInfo = raw
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
    } catch (err: any) {
      if (String(err.message).includes("UNIQUE constraint failed: prompts.owner_user_id, prompts.spec_hash")) {
        const winner = raw
          .prepare("SELECT prompt_id FROM prompts WHERE owner_user_id = ? AND spec_hash = ? AND status = 'confirmed'")
          .get(draft.userId, specHash) as { prompt_id: number };
        throw new Error(`you already have a confirmed prompt with these exact conditions (Prompt ${winner.prompt_id})`);
      }
      throw err;
    }
    const promptId = Number(promptInfo.lastInsertRowid);

    const insertCondition = raw.prepare(
      `INSERT INTO prompt_conditions (prompt_id, cond_no, role, kind, name, params_json, op, value_json, value_origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'user_answer')`
    );
    draft.spec!.conditions.forEach((cond, i) => {
      insertCondition.run(promptId, i + 1, cond.role, cond.kind, cond.name, JSON.stringify(cond.params ?? {}), cond.op, JSON.stringify(cond.value ?? null));
    });

    const watchlistInfo = raw
      .prepare(`INSERT INTO watchlists (user_id, prompt_id, name, created_at) VALUES (?, ?, ?, ?)`)
      .run(draft.userId, promptId, draft.title ?? `Prompt ${promptId}`, now);
    const watchlistId = Number(watchlistInfo.lastInsertRowid);

    raw
      .prepare(`UPDATE prompt_drafts SET status = 'confirmed', confirmed_prompt_id = ?, updated_at = ? WHERE draft_id = ?`)
      .run(promptId, now, draftId);

    return { promptId, watchlistId };
  });

  const { promptId, watchlistId } = createPromptAndWatchlist();

  // runWeeklyScreen does its own HTTP round-trip, so it can't live inside the
  // synchronous better-sqlite3 transaction above. A 422 from the engine must
  // still surface as if nothing had been written, per the confirm.test.ts
  // regression ("propagates a 422... without writing anything") — so on
  // failure here, undo the prompt/watchlist/conditions/draft-status change
  // rather than leaving a prompt with no run at all.
  try {
    await runWeeklyScreen(raw, { promptId, asOf, kind: "catch_up" }, fetchFn);
  } catch (err) {
    raw.transaction(() => {
      raw.prepare("DELETE FROM watchlists WHERE watchlist_id = ?").run(watchlistId);
      raw.prepare("DELETE FROM prompt_conditions WHERE prompt_id = ?").run(promptId);
      raw.prepare("DELETE FROM prompts WHERE prompt_id = ?").run(promptId);
      raw.prepare(`UPDATE prompt_drafts SET status = 'open', confirmed_prompt_id = NULL, updated_at = ? WHERE draft_id = ?`).run(new Date().toISOString(), draftId);
    })();
    throw err;
  }

  return { promptId, watchlistId };
}
```

- [ ] **Step 6: Run the full suite to confirm no regression**

Run: `npm run test -w apps/web`
Expected: PASS, including every existing `tests/confirm.test.ts` case unmodified (the 422/zero-candidate/300-candidate/double-confirm/duplicate-spec assertions all still hold against the refactored code path).

- [ ] **Step 7: Commit**

```bash
git add frontend/apps/web/src/server/weeklyScreen.ts frontend/apps/web/src/server/confirm.ts frontend/apps/web/tests/weeklyScreen.test.ts
git commit -m "refactor(web): extract runWeeklyScreen from confirm.ts, generalised to every following watchlist"
```

---

### Task 4: `jobs.ts` — idempotency wrapper over the `jobs` table

**Files:**
- Create: `apps/web/src/server/jobs.ts`
- Test: `apps/web/tests/jobs.test.ts`

**Interfaces:**
- Consumes: the `jobs` table from Task 1.
- Produces: `withJob<T>(raw: Database.Database, key: { type: string; promptId: number; asOf: string | null }, fn: () => Promise<T>): Promise<{ result: T | null; skipped: boolean }>`. On a fresh `(type, promptId, asOf)`, inserts a `queued` row, flips it to `running`, runs `fn`, flips it to `done` (or `failed` with the error message, re-throwing) and returns `{ result, skipped: false }`. On a key whose row is already `done`, returns `{ result: null, skipped: true }` without calling `fn`. On a key whose row is `failed`, retries: increments `attempts`, runs `fn` again.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/jobs.test.ts
import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { withJob } from "@/server/jobs";

describe("withJob", () => {
  it("runs fn once and marks the job done", async () => {
    const raw = createTestDb();
    const fn = vi.fn().mockResolvedValue(42);
    const { result, skipped } = await withJob(raw, { type: "select_entry", promptId: 1, asOf: "2026-10-02" }, fn);
    expect(result).toBe(42);
    expect(skipped).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
    const row = raw.prepare("SELECT status FROM jobs WHERE type = 'select_entry' AND prompt_id = 1 AND as_of = '2026-10-02'").get() as any;
    expect(row.status).toBe("done");
  });

  it("skips a second call for the same (type, prompt_id, as_of) once the first succeeded", async () => {
    const raw = createTestDb();
    const fn = vi.fn().mockResolvedValue(1);
    await withJob(raw, { type: "select_entry", promptId: 1, asOf: "2026-10-02" }, fn);
    const second = await withJob(raw, { type: "select_entry", promptId: 1, asOf: "2026-10-02" }, fn);
    expect(second.skipped).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("marks the job failed and rethrows when fn throws, and allows a later retry", async () => {
    const raw = createTestDb();
    const failing = vi.fn().mockRejectedValueOnce(new Error("engine down")).mockResolvedValueOnce(7);
    await expect(withJob(raw, { type: "validate_prior", promptId: 1, asOf: "2026-10-02" }, failing)).rejects.toThrow("engine down");
    const row = raw.prepare("SELECT status, attempts, error FROM jobs WHERE type = 'validate_prior' AND prompt_id = 1 AND as_of = '2026-10-02'").get() as any;
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(1);
    expect(row.error).toBe("engine down");

    const retry = await withJob(raw, { type: "validate_prior", promptId: 1, asOf: "2026-10-02" }, failing);
    expect(retry.result).toBe(7);
    expect(retry.skipped).toBe(false);
    const after = raw.prepare("SELECT status, attempts FROM jobs WHERE type = 'validate_prior' AND prompt_id = 1 AND as_of = '2026-10-02'").get() as any;
    expect(after.status).toBe("done");
    expect(after.attempts).toBe(2);
  });

  it("treats a null as_of (not week-scoped) as its own distinct key", async () => {
    const raw = createTestDb();
    const fn = vi.fn().mockResolvedValue("ok");
    await withJob(raw, { type: "catch_up", promptId: 1, asOf: null }, fn);
    const row = raw.prepare("SELECT status FROM jobs WHERE type = 'catch_up' AND prompt_id = 1 AND as_of IS NULL").get() as any;
    expect(row.status).toBe("done");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- jobs.test`
Expected: FAIL — `Cannot find module '@/server/jobs'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/server/jobs.ts
import type Database from "better-sqlite3";

export async function withJob<T>(
  raw: Database.Database,
  key: { type: string; promptId: number; asOf: string | null },
  fn: () => Promise<T>
): Promise<{ result: T | null; skipped: boolean }> {
  const existing = raw
    .prepare(
      key.asOf === null
        ? "SELECT job_id, status, attempts FROM jobs WHERE type = ? AND prompt_id = ? AND as_of IS NULL"
        : "SELECT job_id, status, attempts FROM jobs WHERE type = ? AND prompt_id = ? AND as_of = ?"
    )
    .get(...(key.asOf === null ? [key.type, key.promptId] : [key.type, key.promptId, key.asOf])) as
    | { job_id: number; status: string; attempts: number }
    | undefined;

  if (existing && existing.status === "done") {
    return { result: null, skipped: true };
  }

  const now = new Date().toISOString();
  let jobId: number;
  let attempts: number;
  if (existing) {
    jobId = existing.job_id;
    attempts = existing.attempts;
    raw.prepare("UPDATE jobs SET status = 'running' WHERE job_id = ?").run(jobId);
  } else {
    const info = raw
      .prepare("INSERT INTO jobs (type, prompt_id, as_of, status, attempts, created_at) VALUES (?, ?, ?, 'running', 0, ?)")
      .run(key.type, key.promptId, key.asOf, now);
    jobId = Number(info.lastInsertRowid);
    attempts = 0;
  }

  try {
    const result = await fn();
    raw.prepare("UPDATE jobs SET status = 'done', attempts = ?, finished_at = ? WHERE job_id = ?").run(attempts + 1, new Date().toISOString(), jobId);
    return { result, skipped: false };
  } catch (err) {
    raw.prepare("UPDATE jobs SET status = 'failed', attempts = ?, error = ?, finished_at = ? WHERE job_id = ?").run(
      attempts + 1, (err as Error).message, new Date().toISOString(), jobId
    );
    throw err;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w apps/web -- jobs.test`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/src/server/jobs.ts frontend/apps/web/tests/jobs.test.ts
git commit -m "feat(web): withJob — idempotency wrapper over the jobs table"
```

---

### Task 5: `selectEntry.ts` — `runSelectEntry`, wired into `confirmDraft`

**Files:**
- Create: `apps/web/src/server/selectEntry.ts`
- Modify: `apps/web/src/server/confirm.ts`
- Test: `apps/web/tests/selectEntry.test.ts`, `apps/web/tests/confirm-versioning.test.ts` (selection-warning cases only in this task; versioning cases are added in Task 9)

**Interfaces:**
- Consumes: `selectCandidates` (Task 2), `withJob` (Task 4).
- Produces: `runSelectEntry(raw: Database.Database, { promptId, runId }: { promptId: number; runId: number }, fetchFn?): Promise<{ updated: number }>` — calls the engine, then for every symbol across every watchlist whose `last_run_id = runId`, updates `run_results.entry_status` and `watchlist_entries.status/entry_price/stop/ref_price`, logging an `entry_events` row per entry whose status actually changed. `confirmDraft` now also calls `registerArm` then `runSelectEntry` (both wrapped so a failure becomes a `selectionWarning` string on the returned object instead of throwing) right after the existing `runWeeklyScreen` call, so `confirmDraft`'s return type grows to `{ promptId: number; watchlistId: number; selectionWarning: string | null }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/selectEntry.test.ts
import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { runSelectEntry } from "@/server/selectEntry";

const SPEC = {
  spec_version: 4, structure: "literal" as const, timeframe: "1W" as const,
  selection_point: { session_of_week: 1, at: "open" as const },
  conditions: [], stop: null, risk_cap_pct: null, near_miss: null,
};

function seedRunAndEntries(raw: ReturnType<typeof createTestDb>, rows: { symbol: string; membership: string; status: string }[]) {
  const ownerId = ensureOwnerUser(raw);
  const now = new Date().toISOString();
  raw.prepare(`INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (1, ?, 'x', 'confirmed', ?, ?)`).run(ownerId, now, now);
  raw.prepare(
    `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, confirmed_at)
     VALUES (1, ?, 1, 'Prompt 1', 'x', 'literal', ?, 'h', 'confirmed', 1, 'hyp', 'kill', ?)`
  ).run(ownerId, JSON.stringify(SPEC), now);
  raw.prepare(`INSERT INTO watchlists (watchlist_id, user_id, prompt_id, name, created_at) VALUES (1, ?, 1, 'wl', ?)`).run(ownerId, now);
  const runInfo = raw.prepare(`INSERT INTO runs (prompt_id, as_of, kind, status, finished_at) VALUES (1, '2026-10-02', 'scheduled', 'done', ?)`).run(now);
  const runId = Number(runInfo.lastInsertRowid);
  for (const row of rows) {
    raw.prepare(`INSERT OR IGNORE INTO symbols (symbol, active) VALUES (?, 1)`).run(row.symbol);
    raw.prepare(
      `INSERT INTO run_results (run_id, symbol, membership, in_forward_record, cond_json, entry_status) VALUES (?, ?, ?, 0, '{}', ?)`
    ).run(runId, row.symbol, row.membership, row.status);
    raw.prepare(
      `INSERT INTO watchlist_entries (watchlist_id, symbol, first_run_id, last_run_id, membership, status, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)`
    ).run(row.symbol, runId, runId, row.membership, row.status, now, now);
  }
  return { runId };
}

function fakeSelectFetch(body: unknown) {
  return vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify(body) });
}

describe("runSelectEntry", () => {
  it("marks a full_match pick entered with its entry_price and stop", async () => {
    const raw = createTestDb();
    const { runId } = seedRunAndEntries(raw, [{ symbol: "FULL1", membership: "full_match", status: "pending_selection" }]);
    const fetchFn = fakeSelectFetch({ entered: [{ ticker: "FULL1", membership: "full_match", values: {}, failed_ids: [], ep: 100, sl: 95, r: 0.05, entry_price: 101 }], not_confirmed: [], no_point_data: [], watching: [] });

    await runSelectEntry(raw, { promptId: 1, runId }, fetchFn as any);

    const entry = raw.prepare("SELECT status, entry_price, stop FROM watchlist_entries WHERE symbol = 'FULL1'").get() as any;
    expect(entry).toEqual({ status: "entered", entry_price: 101, stop: 95 });
    const result = raw.prepare("SELECT entry_status FROM run_results WHERE symbol = 'FULL1'").get() as any;
    expect(result.entry_status).toBe("entered");
    const events = raw.prepare("SELECT type, from_value, to_value FROM entry_events").all() as any[];
    expect(events).toEqual([{ type: "status_changed", from_value: "pending_selection", to_value: "entered" }]);
  });

  it("marks a shadow candidate watching with a ref_price, never writing entry_price (D8)", async () => {
    const raw = createTestDb();
    const { runId } = seedRunAndEntries(raw, [{ symbol: "NEAR1", membership: "near_miss", status: "watching" }]);
    const fetchFn = fakeSelectFetch({ entered: [], not_confirmed: [], no_point_data: [], watching: [{ ticker: "NEAR1", membership: "near_miss", values: {}, failed_ids: ["C1"], ep: 50, sl: null, r: null, ref_price: 51.5 }] });

    await runSelectEntry(raw, { promptId: 1, runId }, fetchFn as any);

    const entry = raw.prepare("SELECT status, entry_price, ref_price FROM watchlist_entries WHERE symbol = 'NEAR1'").get() as any;
    expect(entry).toEqual({ status: "watching", entry_price: null, ref_price: 51.5 });
  });

  it("handles a run where every candidate ends up watching, with no entered/not_confirmed/no_point_data at all", async () => {
    const raw = createTestDb();
    const { runId } = seedRunAndEntries(raw, [{ symbol: "NEAR1", membership: "near_miss", status: "watching" }]);
    const fetchFn = fakeSelectFetch({ entered: [], not_confirmed: [], no_point_data: [], watching: [{ ticker: "NEAR1", membership: "near_miss", values: {}, failed_ids: [], ep: 50, sl: null, r: null, ref_price: 51 }] });

    const { updated } = await runSelectEntry(raw, { promptId: 1, runId }, fetchFn as any);
    expect(updated).toBe(1);
    const count = raw.prepare("SELECT COUNT(*) AS n FROM run_results WHERE entry_status = 'entered'").get() as any;
    expect(count.n).toBe(0);
  });

  it("does not log an event when status is unchanged", async () => {
    const raw = createTestDb();
    const { runId } = seedRunAndEntries(raw, [{ symbol: "FULL1", membership: "full_match", status: "entered" }]);
    const fetchFn = fakeSelectFetch({ entered: [{ ticker: "FULL1", membership: "full_match", values: {}, failed_ids: [], ep: 100, sl: 95, r: 0.05, entry_price: 101 }], not_confirmed: [], no_point_data: [], watching: [] });
    await runSelectEntry(raw, { promptId: 1, runId }, fetchFn as any);
    const events = raw.prepare("SELECT COUNT(*) AS n FROM entry_events").get() as any;
    expect(events.n).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- selectEntry.test`
Expected: FAIL — `Cannot find module '@/server/selectEntry'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/server/selectEntry.ts
import type Database from "better-sqlite3";
import { selectCandidates, type SelectCandidate } from "@/server/engine/client";

type Outcome = { status: "entered" | "not_confirmed" | "no_point_data" | "watching"; entryPrice: number | null; stop: number | null; refPrice: number | null };

function outcomeFor(status: Outcome["status"], c: SelectCandidate): Outcome {
  if (status === "entered" || status === "not_confirmed") {
    return { status, entryPrice: c.entry_price ?? null, stop: c.sl ?? null, refPrice: null };
  }
  if (status === "watching") {
    return { status, entryPrice: null, stop: null, refPrice: c.ref_price ?? null };
  }
  return { status: "no_point_data", entryPrice: null, stop: null, refPrice: null };
}

export async function runSelectEntry(
  raw: Database.Database,
  { promptId, runId }: { promptId: number; runId: number },
  fetchFn?: typeof fetch
): Promise<{ updated: number }> {
  const prompt = raw.prepare("SELECT * FROM prompts WHERE prompt_id = ?").get(promptId) as any;
  if (!prompt) throw new Error(`prompt ${promptId} not found`);
  const run = raw.prepare("SELECT * FROM runs WHERE run_id = ? AND prompt_id = ?").get(runId, promptId) as any;
  if (!run) throw new Error(`run ${runId} not found for prompt ${promptId}`);
  const spec = JSON.parse(prompt.spec_json);

  const result = await selectCandidates(spec, run.as_of, promptId, run.kind === "dry_run" ? "dry_run" : "scheduled", fetchFn);

  const byTicker = new Map<string, Outcome>();
  for (const c of result.entered) byTicker.set(c.ticker, outcomeFor("entered", c));
  for (const c of result.not_confirmed) byTicker.set(c.ticker, outcomeFor("not_confirmed", c));
  for (const c of result.no_point_data) byTicker.set(c.ticker, outcomeFor("no_point_data", c));
  for (const c of result.watching) byTicker.set(c.ticker, outcomeFor("watching", c));

  const now = new Date().toISOString();
  const selectEntriesForRun = raw.prepare("SELECT entry_id, symbol, status FROM watchlist_entries WHERE last_run_id = ?");
  const updateRunResult = raw.prepare("UPDATE run_results SET entry_status = ? WHERE run_id = ? AND symbol = ?");
  const updateEntry = raw.prepare(
    `UPDATE watchlist_entries
     SET status = ?, entry_price = ?, stop = ?, ref_price = COALESCE(?, ref_price),
         entry_date = CASE WHEN ? = 'entered' THEN COALESCE(entry_date, ?) ELSE entry_date END,
         updated_at = ?
     WHERE last_run_id = ? AND symbol = ?`
  );
  const insertEvent = raw.prepare("INSERT INTO entry_events (entry_id, run_id, type, from_value, to_value, at) VALUES (?, ?, 'status_changed', ?, ?, ?)");

  const txn = raw.transaction(() => {
    const entriesBefore = selectEntriesForRun.all(runId) as { entry_id: number; symbol: string; status: string }[];

    for (const [ticker, outcome] of byTicker) {
      updateRunResult.run(outcome.status, runId, ticker);
      updateEntry.run(outcome.status, outcome.entryPrice, outcome.stop, outcome.refPrice, outcome.status, run.as_of, now, runId, ticker);
    }

    for (const entry of entriesBefore) {
      const outcome = byTicker.get(entry.symbol);
      if (outcome && outcome.status !== entry.status) {
        insertEvent.run(entry.entry_id, runId, entry.status, outcome.status, now);
      }
    }

    return byTicker.size;
  });

  return { updated: txn() };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w apps/web -- selectEntry.test`
Expected: PASS (4 tests)

- [ ] **Step 5: Wire `registerArm` + `runSelectEntry` into `confirmDraft`, tolerating engine failure**

```ts
// apps/web/src/server/confirm.ts — add imports and change the return type/tail
import { registerArm } from "@/server/engine/client";
import { runSelectEntry } from "@/server/selectEntry";

// ... (unchanged body through the runWeeklyScreen call) ...

export async function confirmDraft(
  raw: Database.Database,
  draftId: number,
  asOf: string,
  fetchFn?: typeof fetch
): Promise<{ promptId: number; watchlistId: number; selectionWarning: string | null }> {
  // ... unchanged through:
  //   const { promptId, watchlistId } = createPromptAndWatchlist();
  //   try { const { runId } = await runWeeklyScreen(...); } catch { ...rollback...; throw err; }
  // except runWeeklyScreen's result is now captured:
  let runId: number;
  try {
    ({ runId } = await runWeeklyScreen(raw, { promptId, asOf, kind: "catch_up" }, fetchFn));
  } catch (err) {
    raw.transaction(() => {
      raw.prepare("DELETE FROM watchlists WHERE watchlist_id = ?").run(watchlistId);
      raw.prepare("DELETE FROM prompt_conditions WHERE prompt_id = ?").run(promptId);
      raw.prepare("DELETE FROM prompts WHERE prompt_id = ?").run(promptId);
      raw.prepare(`UPDATE prompt_drafts SET status = 'open', confirmed_prompt_id = NULL, updated_at = ? WHERE draft_id = ?`).run(new Date().toISOString(), draftId);
    })();
    throw err;
  }

  let selectionWarning: string | null = null;
  try {
    await registerArm(promptId, draft.spec!, fetchFn);
    await runSelectEntry(raw, { promptId, runId }, fetchFn);
  } catch (err) {
    // The prompt/watchlist/run are already committed and real; a transient
    // engine problem here must not undo them (Review Focus item 1) — it only
    // means entries stay at their weekly-screen default status until the
    // next select_entry job (manual retry, or the next weekly catch-up) runs.
    selectionWarning = `prompt confirmed, but selection could not run yet: ${(err as Error).message}`;
  }

  return { promptId, watchlistId, selectionWarning };
}
```

- [ ] **Step 6: Write the engine-down regression test**

```ts
// apps/web/tests/confirm-versioning.test.ts (new file; Task 9 adds the versioning-specific cases to it)
import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { createDraft, updateDraft } from "@/server/drafts";
import { confirmDraft } from "@/server/confirm";

const SPEC = {
  spec_version: 4, structure: "literal" as const, timeframe: "1W" as const,
  selection_point: { session_of_week: 1, at: "open" as const },
  conditions: [{ id: "idMcap", role: "filter" as const, kind: "field" as const, name: "mcap_cr", params: {}, op: "between", value: [10000, 50000] }],
  stop: null, risk_cap_pct: null, near_miss: null,
};

function readyDraft(raw: ReturnType<typeof createTestDb>) {
  const userId = ensureOwnerUser(raw);
  const { draftId } = createDraft(raw, { userId });
  updateDraft(raw, draftId, { title: "Original brief", structure: "literal", specJson: JSON.stringify(SPEC), hypothesis: "h", killCriterion: "k" });
  return draftId;
}

describe("confirmDraft — selection failure tolerance", () => {
  it("still returns promptId/watchlistId with a selectionWarning when /select (or /arms/register) is unreachable after the screen succeeds", async () => {
    const raw = createTestDb();
    const draftId = readyDraft(raw);
    let call = 0;
    const fetchFn = vi.fn().mockImplementation(async (url: string) => {
      call += 1;
      if (url.endsWith("/screen")) {
        return { ok: true, text: async () => JSON.stringify({ candidates: [], applied_steps: [], funnel: [], sector_view: [] }) };
      }
      return { ok: false, status: 503, text: async () => JSON.stringify({ error: "engine unreachable" }) };
    });

    const { promptId, watchlistId, selectionWarning } = await confirmDraft(raw, draftId, "2026-10-02", fetchFn as any);
    expect(promptId).toBeGreaterThan(0);
    expect(watchlistId).toBeGreaterThan(0);
    expect(selectionWarning).toMatch(/selection could not run yet/);

    const prompt = raw.prepare("SELECT status FROM prompts WHERE prompt_id = ?").get(promptId) as any;
    expect(prompt.status).toBe("confirmed");
  });
});
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm run test -w apps/web -- selectEntry.test confirm-versioning.test confirm.test`
Expected: PASS. Note `tests/confirm.test.ts`'s existing assertions destructure `{ promptId, watchlistId }` only, so the added `selectionWarning` field doesn't break them; its fake fetch mocks resolve every URL the same way, so `registerArm`/`runSelectEntry`'s calls succeed trivially there too.

- [ ] **Step 8: Commit**

```bash
git add frontend/apps/web/src/server/selectEntry.ts frontend/apps/web/src/server/confirm.ts frontend/apps/web/tests/selectEntry.test.ts frontend/apps/web/tests/confirm-versioning.test.ts
git commit -m "feat(web): runSelectEntry + wire registerArm/select_entry into confirmDraft (tolerant of engine failure)"
```

---

### Task 6: `validatePrior.ts` — `runValidatePrior`

**Files:**
- Create: `apps/web/src/server/validatePrior.ts`
- Test: `apps/web/tests/validatePrior.test.ts`

**Interfaces:**
- Consumes: `validateArm` (Task 2), `withJob` (Task 4).
- Produces: `runValidatePrior(raw: Database.Database, { promptId, runId }: { promptId: number; runId: number }, fetchFn?): Promise<{ maturity: string; gradedWeeks: number }>`. Reads the owner's watchlist entries with `status = 'entered'` and `first_run_id = runId` as the picks, counts graded weeks so far (`runs` rows for this prompt with `kind IN ('scheduled','catch_up')` and `as_of <= ` this run's `as_of`), calls the engine, and — only when `maturity !== 'not_first_look'` — upserts one `validations` row per horizon (1/2/3) with `n`/`ew_return`/`hit_rate` aggregated from the engine's graded rows for that horizon, leaving `control_ew_return` NULL (Global Constraints).

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/validatePrior.test.ts
import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { runValidatePrior } from "@/server/validatePrior";

const SPEC = {
  spec_version: 4, structure: "literal" as const, timeframe: "1W" as const,
  selection_point: { session_of_week: 1, at: "open" as const },
  conditions: [{ id: "idVstop", role: "event" as const, kind: "indicator" as const, name: "vstop", params: { length: 10, mult: 2, source: "close" }, op: "flip", dir: "long" as const }],
  stop: { from: "idVstop" }, risk_cap_pct: null, near_miss: null,
};

function seedGradableRun(raw: ReturnType<typeof createTestDb>, { gradedRunsBefore }: { gradedRunsBefore: number }) {
  const ownerId = ensureOwnerUser(raw);
  const now = new Date().toISOString();
  raw.prepare(`INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (1, ?, 'x', 'confirmed', ?, ?)`).run(ownerId, now, now);
  raw.prepare(
    `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, confirmed_at)
     VALUES (1, ?, 1, 'Prompt 1', 'x', 'literal', ?, 'h', 'confirmed', 1, 'hyp', 'kill', ?)`
  ).run(ownerId, JSON.stringify(SPEC), now);
  raw.prepare(`INSERT INTO watchlists (watchlist_id, user_id, prompt_id, name, created_at) VALUES (1, ?, 1, 'wl', ?)`).run(ownerId, now);

  for (let i = 0; i < gradedRunsBefore; i++) {
    raw.prepare(`INSERT INTO runs (prompt_id, as_of, kind, status, finished_at) VALUES (1, ?, 'scheduled', 'done', ?)`).run(`2026-0${1 + i}-01`, now);
  }
  const runInfo = raw.prepare(`INSERT INTO runs (prompt_id, as_of, kind, status, finished_at) VALUES (1, '2026-10-02', 'scheduled', 'done', ?)`).run(now);
  const runId = Number(runInfo.lastInsertRowid);
  raw.prepare(`INSERT OR IGNORE INTO symbols (symbol, active) VALUES ('FULL1', 1)`).run();
  raw.prepare(
    `INSERT INTO watchlist_entries (watchlist_id, symbol, first_run_id, last_run_id, membership, status, entry_price, stop, created_at, updated_at)
     VALUES (1, 'FULL1', ?, ?, 'full_match', 'entered', 101, 95, ?, ?)`
  ).run(runId, runId, now, now);
  return { runId };
}

function fakeValidateFetch(body: unknown) {
  return vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify(body) });
}

describe("runValidatePrior", () => {
  it("writes nothing when maturity is not_first_look (fewer than 13 graded weeks)", async () => {
    const raw = createTestDb();
    const { runId } = seedGradableRun(raw, { gradedRunsBefore: 2 });
    const fetchFn = fakeValidateFetch({ graded_weeks: 3, maturity: "not_first_look", rows: [] });

    const result = await runValidatePrior(raw, { promptId: 1, runId }, fetchFn as any);
    expect(result.maturity).toBe("not_first_look");
    const count = raw.prepare("SELECT COUNT(*) AS n FROM validations").get() as any;
    expect(count.n).toBe(0);
  });

  it("aggregates graded rows per horizon into one validations row each, leaving control_ew_return NULL", async () => {
    const raw = createTestDb();
    const { runId } = seedGradableRun(raw, { gradedRunsBefore: 12 });
    const fetchFn = fakeValidateFetch({
      graded_weeks: 13, maturity: "first_look",
      rows: [
        { ticker: "FULL1", signal_week_start: "2026-10-02", horizon_weeks: 1, status: "graded", buy_price: 101, r_Nw: 4.0 },
        { ticker: "FULL1", signal_week_start: "2026-10-02", horizon_weeks: 2, status: "pending", buy_price: 101, r_Nw: null },
      ],
    });

    await runValidatePrior(raw, { promptId: 1, runId }, fetchFn as any);

    const h1 = raw.prepare("SELECT n, ew_return, hit_rate, control_ew_return FROM validations WHERE run_id = ? AND horizon_w = 1").get(runId) as any;
    expect(h1).toEqual({ n: 1, ew_return: 4.0, hit_rate: 1, control_ew_return: null });

    const h2 = raw.prepare("SELECT n FROM validations WHERE run_id = ? AND horizon_w = 2").get(runId) as any;
    expect(h2).toBeUndefined(); // no graded rows for horizon 2 yet (status "pending") -> no row written
  });

  it("passes the owner's entered picks as {ticker, entry_price, sl} to the engine", async () => {
    const raw = createTestDb();
    const { runId } = seedGradableRun(raw, { gradedRunsBefore: 12 });
    const fetchFn = fakeValidateFetch({ graded_weeks: 13, maturity: "first_look", rows: [] });

    await runValidatePrior(raw, { promptId: 1, runId }, fetchFn as any);

    const [, init] = fetchFn.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.picks).toEqual([{ ticker: "FULL1", entry_price: 101, sl: 95 }]);
    expect(body.graded_weeks_so_far).toBe(13);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- validatePrior.test`
Expected: FAIL — `Cannot find module '@/server/validatePrior'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/server/validatePrior.ts
import type Database from "better-sqlite3";
import { validateArm, type ValidateRow } from "@/server/engine/client";

function aggregate(rows: ValidateRow[], horizon: number): { n: number; ewReturn: number; hitRate: number } | null {
  const graded = rows.filter((r) => r.horizon_weeks === horizon && r.status === "graded" && r.r_Nw !== null);
  if (graded.length === 0) return null;
  const n = graded.length;
  const ewReturn = graded.reduce((sum, r) => sum + (r.r_Nw as number), 0) / n;
  const hitRate = graded.filter((r) => (r.r_Nw as number) > 0).length / n;
  return { n, ewReturn, hitRate };
}

export async function runValidatePrior(
  raw: Database.Database,
  { promptId, runId }: { promptId: number; runId: number },
  fetchFn?: typeof fetch
): Promise<{ maturity: string; gradedWeeks: number }> {
  const prompt = raw.prepare("SELECT * FROM prompts WHERE prompt_id = ?").get(promptId) as any;
  if (!prompt) throw new Error(`prompt ${promptId} not found`);
  const run = raw.prepare("SELECT * FROM runs WHERE run_id = ? AND prompt_id = ?").get(runId, promptId) as any;
  if (!run) throw new Error(`run ${runId} not found for prompt ${promptId}`);
  const spec = JSON.parse(prompt.spec_json);

  const gradedWeeksSoFar = (
    raw
      .prepare(`SELECT COUNT(*) AS n FROM runs WHERE prompt_id = ? AND kind IN ('scheduled','catch_up') AND as_of <= ?`)
      .get(promptId, run.as_of) as { n: number }
  ).n;

  const owner = raw.prepare("SELECT watchlist_id FROM watchlists WHERE prompt_id = ? AND user_id = ?").get(promptId, prompt.owner_user_id) as { watchlist_id: number } | undefined;
  const picks = owner
    ? (raw
        .prepare("SELECT symbol, entry_price, stop FROM watchlist_entries WHERE watchlist_id = ? AND first_run_id = ? AND status = 'entered'")
        .all(owner.watchlist_id, runId) as { symbol: string; entry_price: number | null; stop: number | null }[])
    : [];

  const result = await validateArm(
    promptId, spec, run.as_of,
    picks.map((p) => ({ ticker: p.symbol, entry_price: p.entry_price, sl: p.stop })),
    gradedWeeksSoFar, fetchFn
  );

  if (result.maturity !== "not_first_look") {
    const now = new Date().toISOString();
    const upsert = raw.prepare(
      `INSERT INTO validations (run_id, horizon_w, n, ew_return, control_ew_return, hit_rate, computed_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT (run_id, horizon_w) DO UPDATE SET n = excluded.n, ew_return = excluded.ew_return, hit_rate = excluded.hit_rate, computed_at = excluded.computed_at`
    );
    for (const horizon of [1, 2, 3]) {
      const agg = aggregate(result.rows, horizon);
      if (agg) upsert.run(runId, horizon, agg.n, agg.ewReturn, agg.hitRate, now);
    }
  }

  return { maturity: result.maturity, gradedWeeks: result.graded_weeks };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w apps/web -- validatePrior.test`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/src/server/validatePrior.ts frontend/apps/web/tests/validatePrior.test.ts
git commit -m "feat(web): runValidatePrior — grades the owner's entered picks per horizon, skips writes below first-look maturity"
```

---

### Task 7: `catchUp.ts` — `runCatchUp`

**Files:**
- Create: `apps/web/src/server/catchUp.ts`
- Test: `apps/web/tests/catchUp.test.ts`

**Interfaces:**
- Consumes: `runWeeklyScreen` (Task 3), `runSelectEntry` (Task 5), `runValidatePrior` (Task 6), `withJob` (Task 4), `getHealth` (Phase 1 engine client).
- Produces: `runCatchUp(raw: Database.Database, { promptId }: { promptId: number }, fetchFn?): Promise<{ weeksRun: string[] }>` — reads the prompt's last run `as_of`, walks every Friday strictly after it up to and including `getHealth().last_bar_date`, and for each missed Friday runs `weeklyScreen` → `selectEntry` → (`validatePrior`, best-effort) in order, each wrapped in `withJob` keyed by that week's `as_of` so a repeated call is a no-op per week already done.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/catchUp.test.ts
import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { runCatchUp } from "@/server/catchUp";

const SPEC = {
  spec_version: 4, structure: "literal" as const, timeframe: "1W" as const,
  selection_point: { session_of_week: 1, at: "open" as const },
  conditions: [], stop: null, risk_cap_pct: null, near_miss: null,
};

function seedPromptWithOneRun(raw: ReturnType<typeof createTestDb>, lastAsOf: string) {
  const ownerId = ensureOwnerUser(raw);
  const now = new Date().toISOString();
  raw.prepare(`INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (1, ?, 'x', 'confirmed', ?, ?)`).run(ownerId, now, now);
  raw.prepare(
    `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, confirmed_at)
     VALUES (1, ?, 1, 'Prompt 1', 'x', 'literal', ?, 'h', 'confirmed', 1, 'hyp', 'kill', ?)`
  ).run(ownerId, JSON.stringify(SPEC), now);
  raw.prepare(`INSERT INTO watchlists (watchlist_id, user_id, prompt_id, name, created_at) VALUES (1, ?, 1, 'wl', ?)`).run(ownerId, now);
  raw.prepare(`INSERT INTO runs (prompt_id, as_of, kind, status, finished_at) VALUES (1, ?, 'scheduled', 'done', ?)`).run(lastAsOf, now);
}

function fakeFetch() {
  return vi.fn().mockImplementation(async (url: string) => {
    if (url.endsWith("/health")) return { ok: true, text: async () => JSON.stringify({ status: "ok", engine_git_sha: "abc", last_bar_date: "2026-10-16", data_snapshot_hash: null }) };
    if (url.endsWith("/screen")) return { ok: true, text: async () => JSON.stringify({ candidates: [], applied_steps: [], funnel: [], sector_view: [] }) };
    if (url.endsWith("/select")) return { ok: true, text: async () => JSON.stringify({ entered: [], not_confirmed: [], no_point_data: [], watching: [] }) };
    if (url.endsWith("/validate")) return { ok: true, text: async () => JSON.stringify({ graded_weeks: 1, maturity: "not_first_look", rows: [] }) };
    throw new Error(`unexpected url ${url}`);
  });
}

describe("runCatchUp", () => {
  it("runs one weekly cycle per missed Friday between the last run and the engine's last_bar_date", async () => {
    const raw = createTestDb();
    seedPromptWithOneRun(raw, "2026-10-02");
    const fetchFn = fakeFetch();

    const { weeksRun } = await runCatchUp(raw, { promptId: 1 }, fetchFn as any);
    expect(weeksRun).toEqual(["2026-10-09", "2026-10-16"]);

    const runs = raw.prepare("SELECT as_of FROM runs WHERE prompt_id = 1 ORDER BY as_of").all() as any[];
    expect(runs.map((r) => r.as_of)).toEqual(["2026-10-02", "2026-10-09", "2026-10-16"]);
  });

  it("is a no-op on a second call once every missed week is already caught up", async () => {
    const raw = createTestDb();
    seedPromptWithOneRun(raw, "2026-10-02");
    const fetchFn = fakeFetch();
    await runCatchUp(raw, { promptId: 1 }, fetchFn as any);

    const { weeksRun } = await runCatchUp(raw, { promptId: 1 }, fetchFn as any);
    expect(weeksRun).toEqual([]);
    const runCount = raw.prepare("SELECT COUNT(*) AS n FROM runs WHERE prompt_id = 1").get() as any;
    expect(runCount.n).toBe(3);
  });

  it("returns no weeks when already caught up to last_bar_date", async () => {
    const raw = createTestDb();
    seedPromptWithOneRun(raw, "2026-10-16");
    const fetchFn = fakeFetch();
    const { weeksRun } = await runCatchUp(raw, { promptId: 1 }, fetchFn as any);
    expect(weeksRun).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- catchUp.test`
Expected: FAIL — `Cannot find module '@/server/catchUp'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/server/catchUp.ts
import type Database from "better-sqlite3";
import { getHealth } from "@/server/engine/client";
import { runWeeklyScreen } from "@/server/weeklyScreen";
import { runSelectEntry } from "@/server/selectEntry";
import { runValidatePrior } from "@/server/validatePrior";
import { withJob } from "@/server/jobs";

function fridaysBetweenExclusiveInclusive(lastAsOf: string, lastBarDate: string): string[] {
  const out: string[] = [];
  let d = new Date(`${lastAsOf}T00:00:00Z`);
  const end = new Date(`${lastBarDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 7);
  while (d.getTime() <= end.getTime()) {
    out.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime());
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return out;
}

export async function runCatchUp(
  raw: Database.Database,
  { promptId }: { promptId: number },
  fetchFn?: typeof fetch
): Promise<{ weeksRun: string[] }> {
  const lastRun = raw.prepare("SELECT as_of FROM runs WHERE prompt_id = ? ORDER BY as_of DESC LIMIT 1").get(promptId) as { as_of: string } | undefined;
  if (!lastRun) throw new Error(`prompt ${promptId} has no runs yet`);

  const health = await getHealth(fetchFn);
  if (!health.last_bar_date) return { weeksRun: [] };

  const missedWeeks = fridaysBetweenExclusiveInclusive(lastRun.as_of, health.last_bar_date);
  const weeksRun: string[] = [];

  for (const asOf of missedWeeks) {
    const { skipped, result } = await withJob(raw, { type: "catch_up", promptId, asOf }, async () => {
      const { runId } = await runWeeklyScreen(raw, { promptId, asOf, kind: "catch_up" }, fetchFn);
      await runSelectEntry(raw, { promptId, runId }, fetchFn);
      try {
        await runValidatePrior(raw, { promptId, runId }, fetchFn);
      } catch {
        // validate_prior failing never blocks catch-up from moving to the
        // next week — grading can always be retried later once the weekly
        // run itself is safely recorded.
      }
      return runId;
    });
    if (!skipped && result !== null) weeksRun.push(asOf);
  }

  return { weeksRun };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w apps/web -- catchUp.test`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/src/server/catchUp.ts frontend/apps/web/tests/catchUp.test.ts
git commit -m "feat(web): runCatchUp — weekly_screen + select_entry + validate_prior per missed week, idempotent per week"
```

---

### Task 8: CLI script — `scripts/run-weekly-jobs.ts`

**Files:**
- Create: `apps/web/scripts/run-weekly-jobs.ts`
- Modify: `apps/web/package.json` (add `tsx` devDependency and a `jobs:catch-up` script)

**Interfaces:**
- Consumes: `db()` (Phase 1 client), `runCatchUp` (Task 7).
- Produces: a script runnable as `npm run jobs:catch-up -w apps/web`, which calls `runCatchUp` for every `prompts` row with `status = 'confirmed'`, printing one line per prompt with the weeks it ran or `"up to date"`.

This task has no automated test — it is a thin CLI wrapper over already-tested service functions, run manually against the real `data/app.db` and a live engine (same category as Phase 1's own Task 12 Step 6 manual smoke test). It mirrors the existing Python-side pattern of `scripts/weekly_selection_run.sh`, which is itself untested shell orchestration over tested pieces.

- [ ] **Step 1: Add `tsx` and the script entry to `package.json`**

```json
{
  "scripts": {
    "dev": "next dev -H 127.0.0.1",
    "build": "next build",
    "start": "next start -H 127.0.0.1",
    "test": "vitest run",
    "jobs:catch-up": "tsx scripts/run-weekly-jobs.ts"
  },
  "devDependencies": {
    "tsx": "4.19.1"
  }
}
```

(Merge these into the existing `scripts`/`devDependencies` blocks from Phase 1's `package.json` — do not remove any existing entry.)

- [ ] **Step 2: Write the script**

```ts
// apps/web/scripts/run-weekly-jobs.ts
import { db } from "@/server/db/client";
import { runCatchUp } from "@/server/catchUp";

async function main() {
  const raw = db();
  const prompts = raw.prepare("SELECT prompt_id, title FROM prompts WHERE status = 'confirmed'").all() as { prompt_id: number; title: string }[];

  for (const prompt of prompts) {
    try {
      const { weeksRun } = await runCatchUp(raw, { promptId: prompt.prompt_id });
      console.log(
        weeksRun.length > 0
          ? `Prompt ${prompt.prompt_id} (${prompt.title}): caught up ${weeksRun.join(", ")}`
          : `Prompt ${prompt.prompt_id} (${prompt.title}): up to date`
      );
    } catch (err) {
      console.error(`Prompt ${prompt.prompt_id} (${prompt.title}): FAILED — ${(err as Error).message}`);
    }
  }
}

main();
```

- [ ] **Step 3: Install and do one manual run**

Run (from `frontend/`): `npm install`
Then, with the Python engine running on `127.0.0.1:8001` and at least one confirmed prompt in `data/app.db`: `npm run jobs:catch-up -w apps/web`
Expected: one printed line per confirmed prompt; re-running immediately prints `up to date` for all of them (idempotency from Task 7's `withJob` wrapping).

- [ ] **Step 4: Commit**

```bash
git add frontend/apps/web/package.json frontend/apps/web/scripts/run-weekly-jobs.ts frontend/package-lock.json
git commit -m "feat(web): scripts/run-weekly-jobs.ts — manual/cron catch-up entry point over every confirmed prompt"
```

---

### Task 9: `prompts.ts` — edit (versioning) and retire

**Files:**
- Create: `apps/web/src/server/prompts.ts`
- Modify: `apps/web/src/server/confirm.ts` (confirming an edit draft mints a new version instead of a fresh prompt)
- Test: `apps/web/tests/prompts.test.ts`, append to `apps/web/tests/confirm-versioning.test.ts`

**Interfaces:**
- Produces: `createEditDraft(raw: Database.Database, { promptId, userId }: { promptId: number; userId: number }): { draftId: number }` — throws if the prompt is `superseded` or `retired`; otherwise creates a new `prompt_drafts` row with `parent_prompt_id = promptId`, pre-filled `structure`/`specJson`/`hypothesis`/`killCriterion` copied from the confirmed prompt (still editable from there). `retirePrompt(raw: Database.Database, promptId: number, fetchFn?): Promise<void>` — sets `status = 'retired'`, `closed_at = now`, and calls `retireArm`. `confirmDraft` (modified) now checks `draft.parentPromptId`: if set, the new prompt row also gets `parent_prompt_id` and `version = parent.version + 1`, and — once the new prompt and its first `runWeeklyScreen`/`registerArm` succeed — the parent is marked `superseded` and `retireArm(parentId)` is called (best-effort, same tolerance as Task 5).

- [ ] **Step 1: Write the failing test for `createEditDraft`/`retirePrompt`**

```ts
// apps/web/tests/prompts.test.ts
import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { createEditDraft, retirePrompt } from "@/server/prompts";
import { getDraft } from "@/server/drafts";

const SPEC = {
  spec_version: 4, structure: "literal" as const, timeframe: "1W" as const,
  selection_point: { session_of_week: 1, at: "open" as const },
  conditions: [], stop: null, risk_cap_pct: null, near_miss: null,
};

function seedConfirmedPrompt(raw: ReturnType<typeof createTestDb>, status = "confirmed") {
  const ownerId = ensureOwnerUser(raw);
  const now = new Date().toISOString();
  raw.prepare(`INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (1, ?, 'x', 'confirmed', ?, ?)`).run(ownerId, now, now);
  raw.prepare(
    `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, confirmed_at)
     VALUES (1, ?, 1, 'Prompt 1', 'the original brief', 'literal', ?, 'h', ?, 1, 'hyp', 'kill', ?)`
  ).run(ownerId, JSON.stringify(SPEC), status, now);
  return { ownerId };
}

describe("createEditDraft", () => {
  it("creates a new open draft parented to the confirmed prompt, pre-filled with its spec", () => {
    const raw = createTestDb();
    const { ownerId } = seedConfirmedPrompt(raw);
    const { draftId } = createEditDraft(raw, { promptId: 1, userId: ownerId });
    const draft = getDraft(raw, draftId)!;
    expect(draft.status).toBe("open");
    expect(draft.structure).toBe("literal");
    expect(draft.spec).toEqual(SPEC);
    expect(draft.hypothesis).toBe("hyp");
    const row = raw.prepare("SELECT parent_prompt_id, prompt_text FROM prompt_drafts WHERE draft_id = ?").get(draftId) as any;
    expect(row.parent_prompt_id).toBe(1);
    expect(row.prompt_text).toBe("the original brief");
  });

  it("refuses to edit an already-superseded prompt", () => {
    const raw = createTestDb();
    const { ownerId } = seedConfirmedPrompt(raw, "superseded");
    expect(() => createEditDraft(raw, { promptId: 1, userId: ownerId })).toThrow(/already superseded/);
  });

  it("refuses to edit an already-retired prompt", () => {
    const raw = createTestDb();
    const { ownerId } = seedConfirmedPrompt(raw, "retired");
    expect(() => createEditDraft(raw, { promptId: 1, userId: ownerId })).toThrow(/already retired/);
  });
});

describe("retirePrompt", () => {
  it("marks the prompt retired and calls the engine's retire endpoint", async () => {
    const raw = createTestDb();
    seedConfirmedPrompt(raw);
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ prompt_id: 1, status: "retired" }) });
    await retirePrompt(raw, 1, fetchFn as any);
    const row = raw.prepare("SELECT status, closed_at FROM prompts WHERE prompt_id = 1").get() as any;
    expect(row.status).toBe("retired");
    expect(row.closed_at).not.toBeNull();
    expect(fetchFn).toHaveBeenCalledWith("http://127.0.0.1:8001/arms/1/retire", expect.anything());
  });

  it("refuses to retire a prompt that is already retired", async () => {
    const raw = createTestDb();
    seedConfirmedPrompt(raw, "retired");
    await expect(retirePrompt(raw, 1, vi.fn() as any)).rejects.toThrow(/already retired/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- prompts.test`
Expected: FAIL — `Cannot find module '@/server/prompts'`

- [ ] **Step 3: Write `createEditDraft` and `retirePrompt`**

```ts
// apps/web/src/server/prompts.ts
import type Database from "better-sqlite3";
import { retireArm } from "@/server/engine/client";

export function createEditDraft(raw: Database.Database, { promptId, userId }: { promptId: number; userId: number }): { draftId: number } {
  const prompt = raw.prepare("SELECT * FROM prompts WHERE prompt_id = ?").get(promptId) as any;
  if (!prompt) throw new Error(`prompt ${promptId} not found`);
  if (prompt.status === "superseded") throw new Error(`prompt ${promptId} is already superseded`);
  if (prompt.status === "retired") throw new Error(`prompt ${promptId} is already retired`);

  const now = new Date().toISOString();
  const info = raw
    .prepare(
      `INSERT INTO prompt_drafts
         (user_id, parent_prompt_id, title, prompt_text, structure, spec_json, hypothesis, kill_criterion, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
    )
    .run(userId, promptId, prompt.title, prompt.prompt_text, prompt.structure, prompt.spec_json, prompt.hypothesis, prompt.kill_criterion, now, now);
  return { draftId: Number(info.lastInsertRowid) };
}

export async function retirePrompt(raw: Database.Database, promptId: number, fetchFn?: typeof fetch): Promise<void> {
  const prompt = raw.prepare("SELECT status FROM prompts WHERE prompt_id = ?").get(promptId) as { status: string } | undefined;
  if (!prompt) throw new Error(`prompt ${promptId} not found`);
  if (prompt.status === "retired") throw new Error(`prompt ${promptId} is already retired`);

  const now = new Date().toISOString();
  raw.prepare("UPDATE prompts SET status = 'retired', closed_at = ? WHERE prompt_id = ?").run(now, promptId);
  await retireArm(promptId, fetchFn);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w apps/web -- prompts.test`
Expected: PASS (5 tests)

- [ ] **Step 5: Teach `confirmDraft` to mint a new version when the draft has a `parentPromptId`**

```ts
// apps/web/src/server/confirm.ts — modify createPromptAndWatchlist's INSERT and add the post-commit supersede step
import { retireArm } from "@/server/engine/client"; // alongside the existing registerArm import

// Inside createPromptAndWatchlist, before the INSERT INTO prompts:
const parent = draft.parentPromptId
  ? (raw.prepare("SELECT prompt_id, version, status FROM prompts WHERE prompt_id = ?").get(draft.parentPromptId) as { prompt_id: number; version: number; status: string } | undefined)
  : null;
if (draft.parentPromptId && !parent) throw new Error(`parent prompt ${draft.parentPromptId} not found`);
if (parent && parent.status !== "confirmed") throw new Error(`parent prompt ${parent.prompt_id} is already ${parent.status}`);

// Replace the fixed "'confirmed', 1," in the INSERT with the computed values:
promptInfo = raw
  .prepare(
    `INSERT INTO prompts
       (owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash,
        status, parent_prompt_id, version, hypothesis, kill_criterion, confirmed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?)`
  )
  .run(
    draft.userId, draftId, draft.title ?? `Prompt from draft ${draftId}`, draft.promptText,
    draft.structure, specJson, specHash, parent ? parent.prompt_id : null, parent ? parent.version + 1 : 1,
    draft.hypothesis, draft.killCriterion, now
  );

// After the existing registerArm/runSelectEntry try/catch block, before "return { promptId, watchlistId, selectionWarning };":
if (parent) {
  try {
    raw.prepare("UPDATE prompts SET status = 'superseded', closed_at = ? WHERE prompt_id = ?").run(new Date().toISOString(), parent.prompt_id);
    await retireArm(parent.prompt_id, fetchFn);
  } catch (err) {
    selectionWarning = selectionWarning
      ? `${selectionWarning}; also failed to supersede prompt ${parent.prompt_id}: ${(err as Error).message}`
      : `prompt confirmed as version ${parent.version + 1}, but retiring the old Prompt ${parent.prompt_id} failed: ${(err as Error).message}`;
  }
}
```

- [ ] **Step 6: Write the versioning test**

```ts
// apps/web/tests/confirm-versioning.test.ts — append
import { createEditDraft } from "@/server/prompts";

describe("confirmDraft — versioning", () => {
  it("confirming an edit draft mints a new prompt_id, parent_prompt_id, version 2, and supersedes the old prompt", async () => {
    const raw = createTestDb();
    const draftId = readyDraft(raw);
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ candidates: [], applied_steps: [], funnel: [], sector_view: [], entered: [], not_confirmed: [], no_point_data: [], watching: [], prompt_id: 1, status: "active" }) });
    const { promptId: v1Id } = await confirmDraft(raw, draftId, "2026-10-02", fetchFn as any);

    const { draftId: editDraftId } = createEditDraft(raw, { promptId: v1Id, userId: ensureOwnerUser(raw) });
    const { promptId: v2Id } = await confirmDraft(raw, editDraftId, "2026-10-09", fetchFn as any);

    expect(v2Id).not.toBe(v1Id);
    const v2 = raw.prepare("SELECT parent_prompt_id, version, status FROM prompts WHERE prompt_id = ?").get(v2Id) as any;
    expect(v2).toEqual({ parent_prompt_id: v1Id, version: 2, status: "confirmed" });
    const v1 = raw.prepare("SELECT status FROM prompts WHERE prompt_id = ?").get(v1Id) as any;
    expect(v1.status).toBe("superseded");
  });
});
```

(This appended block reuses `readyDraft`/`createTestDb`/`ensureOwnerUser`/`confirmDraft` already imported earlier in the same file from Task 5's Step 6 — no new imports needed beyond `createEditDraft`.)

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm run test -w apps/web -- confirm-versioning.test prompts.test`
Expected: PASS (6 tests total across both describe blocks in `confirm-versioning.test.ts`, plus `prompts.test.ts`'s 5)

- [ ] **Step 8: Commit**

```bash
git add frontend/apps/web/src/server/prompts.ts frontend/apps/web/src/server/confirm.ts frontend/apps/web/tests/prompts.test.ts frontend/apps/web/tests/confirm-versioning.test.ts
git commit -m "feat(web): createEditDraft/retirePrompt + confirmDraft mints new prompt_id/version on edit, supersedes the parent"
```

---

### Task 10: Routes — `GET /api/prompts`, `POST /api/prompts/:promptId/edit`, `POST /api/prompts/:promptId/retire`

**Files:**
- Create: `apps/web/src/server/listPrompts.ts`, `apps/web/app/api/prompts/route.ts`, `apps/web/app/api/prompts/[promptId]/edit/route.ts`, `apps/web/app/api/prompts/[promptId]/retire/route.ts`
- Test: `apps/web/tests/listPrompts.test.ts`, `apps/web/tests/api-wiring-p2.test.ts`

**Interfaces:**
- Produces: `listPrompts(raw: Database.Database, { userId, view }: { userId: number; view: "mine" | "drafts" }): PromptListRow[] | DraftListRow[]`. For `view: "mine"`: one row per prompt owned by `userId`, `{ promptId, title, structure, status, version, parentPromptId, gradedWeeks, lastHorizon1Return }` — `gradedWeeks` from `COUNT(runs WHERE kind IN ('scheduled','catch_up'))`, `lastHorizon1Return` from the most recent `validations` row at `horizon_w = 1` for that prompt's latest run (NULL if none yet). For `view: "drafts"`: one row per open/abandoned draft owned by `userId`, `{ draftId, title, lastEditedAt, blockedReason }` where `blockedReason` is `"no spec yet"` when `structure`/`specJson` is null, `"missing hypothesis/kill criterion"` when either is empty, else `null`. The three routes are thin wiring: `GET /api/prompts?view=mine|drafts` → `listPrompts`; `POST /api/prompts/:promptId/edit` → `createEditDraft`, `201 { draft_id }`; `POST /api/prompts/:promptId/retire` → `retirePrompt`, `200 { prompt_id, status: "retired" }`.

- [ ] **Step 1: Write the failing test for `listPrompts`**

```ts
// apps/web/tests/listPrompts.test.ts
import { describe, expect, it } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { listPrompts } from "@/server/listPrompts";
import { createDraft, updateDraft } from "@/server/drafts";

function seedTwoPrompts(raw: ReturnType<typeof createTestDb>) {
  const ownerId = ensureOwnerUser(raw);
  const now = new Date().toISOString();
  for (const [promptId, version, parent, status] of [[1, 1, null, "superseded"], [2, 2, 1, "confirmed"]] as const) {
    raw.prepare(`INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (?, ?, 'x', 'confirmed', ?, ?)`).run(promptId, ownerId, now, now);
    raw.prepare(
      `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, parent_prompt_id, version, hypothesis, kill_criterion, confirmed_at)
       VALUES (?, ?, ?, 'T', 'x', 'literal', '{}', ?, ?, ?, ?, 'h', 'k', ?)`
    ).run(promptId, ownerId, promptId, `hash${promptId}`, status, parent, version, now);
    raw.prepare(`INSERT INTO runs (prompt_id, as_of, kind, status, finished_at) VALUES (?, '2026-10-02', 'scheduled', 'done', ?)`).run(promptId, now);
  }
  raw.prepare(`INSERT INTO validations (run_id, horizon_w, n, ew_return, hit_rate, computed_at) VALUES (2, 1, 5, 3.2, 0.6, ?)`).run(now);
  return { ownerId };
}

describe("listPrompts — view mine", () => {
  it("returns every owned prompt with its version chain and latest 1-week validation", () => {
    const raw = createTestDb();
    const { ownerId } = seedTwoPrompts(raw);
    const rows = listPrompts(raw, { userId: ownerId, view: "mine" }) as any[];
    const v2 = rows.find((r) => r.promptId === 2);
    expect(v2).toMatchObject({ parentPromptId: 1, version: 2, status: "confirmed", gradedWeeks: 1, lastHorizon1Return: 3.2 });
    const v1 = rows.find((r) => r.promptId === 1);
    expect(v1).toMatchObject({ status: "superseded", lastHorizon1Return: null });
  });
});

describe("listPrompts — view drafts", () => {
  it("flags a draft with no spec yet as blocked", () => {
    const raw = createTestDb();
    const userId = ensureOwnerUser(raw);
    const { draftId } = createDraft(raw, { userId });
    const rows = listPrompts(raw, { userId, view: "drafts" }) as any[];
    expect(rows).toEqual([expect.objectContaining({ draftId, blockedReason: "no spec yet" })]);
  });

  it("flags a draft missing hypothesis/kill criterion, once it has a spec", () => {
    const raw = createTestDb();
    const userId = ensureOwnerUser(raw);
    const { draftId } = createDraft(raw, { userId });
    updateDraft(raw, draftId, { structure: "literal", specJson: JSON.stringify({ spec_version: 4, structure: "literal", timeframe: "1W", selection_point: null, conditions: [], stop: null, risk_cap_pct: null, near_miss: null }) });
    const rows = listPrompts(raw, { userId, view: "drafts" }) as any[];
    expect(rows[0].blockedReason).toBe("missing hypothesis/kill criterion");
  });

  it("reports blockedReason null once a draft is ready to confirm", () => {
    const raw = createTestDb();
    const userId = ensureOwnerUser(raw);
    const { draftId } = createDraft(raw, { userId });
    updateDraft(raw, draftId, {
      structure: "literal",
      specJson: JSON.stringify({ spec_version: 4, structure: "literal", timeframe: "1W", selection_point: null, conditions: [], stop: null, risk_cap_pct: null, near_miss: null }),
      hypothesis: "h", killCriterion: "k",
    });
    const rows = listPrompts(raw, { userId, view: "drafts" }) as any[];
    expect(rows[0].blockedReason).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- listPrompts.test`
Expected: FAIL — `Cannot find module '@/server/listPrompts'`

- [ ] **Step 3: Write `listPrompts.ts`**

```ts
// apps/web/src/server/listPrompts.ts
import type Database from "better-sqlite3";

export function listPrompts(raw: Database.Database, { userId, view }: { userId: number; view: "mine" | "drafts" }) {
  if (view === "drafts") {
    return (raw.prepare("SELECT * FROM prompt_drafts WHERE user_id = ? AND status != 'confirmed' ORDER BY updated_at DESC").all(userId) as any[]).map((d) => {
      let blockedReason: string | null = null;
      if (!d.structure || !d.spec_json) blockedReason = "no spec yet";
      else if (!d.hypothesis || !d.kill_criterion) blockedReason = "missing hypothesis/kill criterion";
      return { draftId: d.draft_id, title: d.title, lastEditedAt: d.updated_at, blockedReason };
    });
  }

  const prompts = raw.prepare("SELECT * FROM prompts WHERE owner_user_id = ? ORDER BY prompt_id DESC").all(userId) as any[];
  const selectGradedWeeks = raw.prepare("SELECT COUNT(*) AS n FROM runs WHERE prompt_id = ? AND kind IN ('scheduled','catch_up')");
  const selectLastRun = raw.prepare("SELECT run_id FROM runs WHERE prompt_id = ? ORDER BY run_id DESC LIMIT 1");
  const selectHorizon1 = raw.prepare("SELECT ew_return FROM validations WHERE run_id = ? AND horizon_w = 1");

  return prompts.map((p) => {
    const gradedWeeks = (selectGradedWeeks.get(p.prompt_id) as { n: number }).n;
    const lastRun = selectLastRun.get(p.prompt_id) as { run_id: number } | undefined;
    const validation = lastRun ? (selectHorizon1.get(lastRun.run_id) as { ew_return: number } | undefined) : undefined;
    return {
      promptId: p.prompt_id, title: p.title, structure: p.structure, status: p.status,
      version: p.version, parentPromptId: p.parent_prompt_id, gradedWeeks,
      lastHorizon1Return: validation ? validation.ew_return : null,
    };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w apps/web -- listPrompts.test`
Expected: PASS (4 tests)

- [ ] **Step 5: Write the three routes**

```ts
// apps/web/app/api/prompts/route.ts
import { db } from "@/server/db/client";
import { listPrompts } from "@/server/listPrompts";

const OWNER_USER_ID = 1;

export async function GET(req: Request) {
  const view = new URL(req.url).searchParams.get("view") === "drafts" ? "drafts" : "mine";
  return Response.json(listPrompts(db(), { userId: OWNER_USER_ID, view }));
}
```

```ts
// apps/web/app/api/prompts/[promptId]/edit/route.ts
import { db } from "@/server/db/client";
import { createEditDraft } from "@/server/prompts";

const OWNER_USER_ID = 1;

export async function POST(_req: Request, { params }: { params: { promptId: string } }) {
  try {
    const { draftId } = createEditDraft(db(), { promptId: Number(params.promptId), userId: OWNER_USER_ID });
    return Response.json({ draft_id: draftId }, { status: 201 });
  } catch (err) {
    const status = /not found/.test((err as Error).message) ? 404 : 409;
    return Response.json({ error: (err as Error).message }, { status });
  }
}
```

```ts
// apps/web/app/api/prompts/[promptId]/retire/route.ts
import { db } from "@/server/db/client";
import { retirePrompt } from "@/server/prompts";

export async function POST(_req: Request, { params }: { params: { promptId: string } }) {
  const promptId = Number(params.promptId);
  try {
    await retirePrompt(db(), promptId);
    return Response.json({ prompt_id: promptId, status: "retired" });
  } catch (err) {
    const status = /not found/.test((err as Error).message) ? 404 : 409;
    return Response.json({ error: (err as Error).message }, { status });
  }
}
```

- [ ] **Step 6: Write the wiring test**

```ts
// apps/web/tests/api-wiring-p2.test.ts
import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";

vi.mock("@/server/db/client", () => ({ db: vi.fn() }));

describe("GET /api/prompts route wiring", () => {
  it("defaults to view=mine and returns listPrompts's shape", async () => {
    const { db } = await import("@/server/db/client");
    const raw = createTestDb();
    ensureOwnerUser(raw);
    (db as any).mockReturnValue(raw);

    const { GET } = await import("@/app/api/prompts/route");
    const res = await GET(new Request("http://localhost/api/prompts"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });
});
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm run test -w apps/web -- listPrompts.test api-wiring-p2.test`
Expected: PASS (5 tests)

- [ ] **Step 8: Commit**

```bash
git add frontend/apps/web/src/server/listPrompts.ts frontend/apps/web/app/api/prompts frontend/apps/web/tests/listPrompts.test.ts frontend/apps/web/tests/api-wiring-p2.test.ts
git commit -m "feat(web): GET /api/prompts, POST .../edit, POST .../retire"
```

---

### Task 11: `validations.ts` + `entryDetail.ts` services, and their routes

**Files:**
- Create: `apps/web/src/server/validations.ts`, `apps/web/src/server/entryDetail.ts`, `apps/web/app/api/watchlists/[watchlistId]/entries/[entryId]/route.ts`
- Test: `apps/web/tests/validations.test.ts`, `apps/web/tests/entryDetail.test.ts`

**Interfaces:**
- Produces: `getValidationSummary(raw: Database.Database, promptId: number): { gradedWeeks: number; horizons: { horizon: 1 | 2 | 3; n: number; ewReturn: number | null; hitRate: number | null }[] }` — one row per horizon from the prompt's **latest** run that has a `validations` entry (not necessarily the very latest run, since a just-run `weekly_screen` may not be graded yet); `gradedWeeks` is the same `COUNT(runs ...)` used in Task 6/10. `getEntryDetail(raw: Database.Database, entryId: number): EntryDetail | null` — the entry's current row plus its full `entry_events` history ordered by `at`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/tests/validations.test.ts
import { describe, expect, it } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { getValidationSummary } from "@/server/validations";

function seedPromptWithGradedAndUngradedRuns(raw: ReturnType<typeof createTestDb>) {
  const ownerId = ensureOwnerUser(raw);
  const now = new Date().toISOString();
  raw.prepare(`INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (1, ?, 'x', 'confirmed', ?, ?)`).run(ownerId, now, now);
  raw.prepare(
    `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, confirmed_at)
     VALUES (1, ?, 1, 'T', 'x', 'literal', '{}', 'h', 'confirmed', 1, 'h', 'k', ?)`
  ).run(ownerId, now);
  raw.prepare(`INSERT INTO runs (run_id, prompt_id, as_of, kind, status, finished_at) VALUES (10, 1, '2026-10-02', 'scheduled', 'done', ?)`).run(now);
  raw.prepare(`INSERT INTO runs (run_id, prompt_id, as_of, kind, status, finished_at) VALUES (11, 1, '2026-10-09', 'scheduled', 'done', ?)`).run(now);
  raw.prepare(`INSERT INTO validations (run_id, horizon_w, n, ew_return, hit_rate, computed_at) VALUES (10, 1, 5, 2.0, 0.6, ?)`).run(now);
  raw.prepare(`INSERT INTO validations (run_id, horizon_w, n, ew_return, hit_rate, computed_at) VALUES (10, 2, 5, 1.0, 0.4, ?)`).run(now);
  return { ownerId };
}

describe("getValidationSummary", () => {
  it("returns the latest graded run's per-horizon numbers, not the latest (possibly ungraded) run", () => {
    const raw = createTestDb();
    seedPromptWithGradedAndUngradedRuns(raw);
    const summary = getValidationSummary(raw, 1);
    expect(summary.gradedWeeks).toBe(2);
    expect(summary.horizons).toEqual([
      { horizon: 1, n: 5, ewReturn: 2.0, hitRate: 0.6 },
      { horizon: 2, n: 5, ewReturn: 1.0, hitRate: 0.4 },
    ]);
  });

  it("returns an empty horizons array with the right gradedWeeks when nothing is graded yet", () => {
    const raw = createTestDb();
    const ownerId = ensureOwnerUser(raw);
    const now = new Date().toISOString();
    raw.prepare(`INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (1, ?, 'x', 'confirmed', ?, ?)`).run(ownerId, now, now);
    raw.prepare(
      `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, confirmed_at)
       VALUES (1, ?, 1, 'T', 'x', 'literal', '{}', 'h', 'confirmed', 1, 'h', 'k', ?)`
    ).run(ownerId, now);
    raw.prepare(`INSERT INTO runs (run_id, prompt_id, as_of, kind, status, finished_at) VALUES (10, 1, '2026-10-02', 'scheduled', 'done', ?)`).run(now);
    const summary = getValidationSummary(raw, 1);
    expect(summary).toEqual({ gradedWeeks: 1, horizons: [] });
  });
});
```

```ts
// apps/web/tests/entryDetail.test.ts
import { describe, expect, it } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { getEntryDetail } from "@/server/entryDetail";

describe("getEntryDetail", () => {
  it("returns the entry and its event history in chronological order", () => {
    const raw = createTestDb();
    const ownerId = ensureOwnerUser(raw);
    const now = new Date().toISOString();
    raw.prepare(`INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (1, ?, 'x', 'confirmed', ?, ?)`).run(ownerId, now, now);
    raw.prepare(
      `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, confirmed_at)
       VALUES (1, ?, 1, 'T', 'x', 'literal', '{}', 'h', 'confirmed', 1, 'h', 'k', ?)`
    ).run(ownerId, now);
    raw.prepare(`INSERT INTO watchlists (watchlist_id, user_id, prompt_id, name, created_at) VALUES (1, ?, 1, 'wl', ?)`).run(ownerId, now);
    raw.prepare(`INSERT INTO runs (run_id, prompt_id, as_of, kind, status, finished_at) VALUES (10, 1, '2026-10-02', 'scheduled', 'done', ?)`).run(now);
    raw.prepare(`INSERT OR IGNORE INTO symbols (symbol, active) VALUES ('FULL1', 1)`).run();
    const entryInfo = raw.prepare(
      `INSERT INTO watchlist_entries (watchlist_id, symbol, first_run_id, last_run_id, membership, status, created_at, updated_at) VALUES (1, 'FULL1', 10, 10, 'full_match', 'entered', ?, ?)`
    ).run(now, now);
    const entryId = Number(entryInfo.lastInsertRowid);
    raw.prepare(`INSERT INTO entry_events (entry_id, run_id, type, from_value, to_value, at) VALUES (?, 10, 'status_changed', 'pending_selection', 'entered', '2026-10-02T09:00:00Z')`).run(entryId);
    raw.prepare(`INSERT INTO entry_events (entry_id, run_id, type, from_value, to_value, at) VALUES (?, 10, 'note_added', NULL, 'watching the gap', '2026-10-01T09:00:00Z')`).run(entryId);

    const detail = getEntryDetail(raw, entryId)!;
    expect(detail.symbol).toBe("FULL1");
    expect(detail.events.map((e) => e.type)).toEqual(["note_added", "status_changed"]);
  });

  it("returns null for an unknown entry id", () => {
    const raw = createTestDb();
    expect(getEntryDetail(raw, 999)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -w apps/web -- validations.test entryDetail.test`
Expected: FAIL — modules don't exist yet.

- [ ] **Step 3: Write `validations.ts` and `entryDetail.ts`**

```ts
// apps/web/src/server/validations.ts
import type Database from "better-sqlite3";

export function getValidationSummary(raw: Database.Database, promptId: number) {
  const gradedWeeks = (
    raw.prepare("SELECT COUNT(*) AS n FROM runs WHERE prompt_id = ? AND kind IN ('scheduled','catch_up')").get(promptId) as { n: number }
  ).n;

  const latestGradedRun = raw
    .prepare(
      `SELECT r.run_id FROM runs r
       WHERE r.prompt_id = ? AND EXISTS (SELECT 1 FROM validations v WHERE v.run_id = r.run_id)
       ORDER BY r.as_of DESC LIMIT 1`
    )
    .get(promptId) as { run_id: number } | undefined;

  if (!latestGradedRun) return { gradedWeeks, horizons: [] };

  const horizons = (
    raw.prepare("SELECT horizon_w, n, ew_return, hit_rate FROM validations WHERE run_id = ? ORDER BY horizon_w").all(latestGradedRun.run_id) as any[]
  ).map((row) => ({ horizon: row.horizon_w, n: row.n, ewReturn: row.ew_return, hitRate: row.hit_rate }));

  return { gradedWeeks, horizons };
}
```

```ts
// apps/web/src/server/entryDetail.ts
import type Database from "better-sqlite3";

export function getEntryDetail(raw: Database.Database, entryId: number) {
  const entry = raw.prepare("SELECT * FROM watchlist_entries WHERE entry_id = ?").get(entryId) as any;
  if (!entry) return null;

  const events = (raw.prepare("SELECT type, from_value, to_value, at FROM entry_events WHERE entry_id = ? ORDER BY at ASC").all(entryId) as any[]).map((e) => ({
    type: e.type, fromValue: e.from_value, toValue: e.to_value, at: e.at,
  }));

  return {
    entryId: entry.entry_id, symbol: entry.symbol, membership: entry.membership, status: entry.status,
    entryPrice: entry.entry_price, stop: entry.stop, refPrice: entry.ref_price, userNote: entry.user_note,
    events,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -w apps/web -- validations.test entryDetail.test`
Expected: PASS (4 tests)

- [ ] **Step 5: Write the entry-detail route**

```ts
// apps/web/app/api/watchlists/[watchlistId]/entries/[entryId]/route.ts
import { db } from "@/server/db/client";
import { getEntryDetail } from "@/server/entryDetail";

export async function GET(_req: Request, { params }: { params: { watchlistId: string; entryId: string } }) {
  const detail = getEntryDetail(db(), Number(params.entryId));
  if (!detail) return Response.json({ error: "entry not found" }, { status: 404 });
  return Response.json(detail);
}
```

- [ ] **Step 6: Commit**

```bash
git add frontend/apps/web/src/server/validations.ts frontend/apps/web/src/server/entryDetail.ts frontend/apps/web/app/api/watchlists/\[watchlistId\]/entries frontend/apps/web/tests/validations.test.ts frontend/apps/web/tests/entryDetail.test.ts
git commit -m "feat(web): getValidationSummary + getEntryDetail services and the entry-detail route"
```

---

### Task 12: Frontend — My Prompts page (Mine / Drafts tabs, version chain)

**Files:**
- Create: `apps/web/src/components/VersionChain.tsx`, `apps/web/app/prompts/page.tsx`
- Test: `apps/web/tests/components/VersionChain.test.tsx`

**Interfaces:**
- Produces: `VersionChain({ promptId, parentPromptId, version }: { promptId: number; parentPromptId: number | null; version: number })` — renders `"Prompt {parentPromptId} → Prompt {promptId}"` when there's a parent, with the note "Old versions keep their records and stop being graded" (frontend plan §3.3), or just `"Prompt {promptId}"` (version {version}) when there's no parent. `app/prompts/page.tsx` fetches `GET /api/prompts?view=mine` and `GET /api/prompts?view=drafts`, renders a Mine/Drafts tab switch (a third "Following" tab is added as a disabled placeholder — frontend plan §7 assigns it to P4, which isn't built yet — labelled "Following (needs sharing, not yet built)"), the Mine table (Prompt # · Title · Structure · Owner · Status/visibility · Graded (N) · 1-week vs Control · Open watchlist / Edit as new version / Retire), and the Drafts tab (cards with `blockedReason` or "Ready to confirm").

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/tests/components/VersionChain.test.tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { VersionChain } from "@/components/VersionChain";

describe("VersionChain", () => {
  it("shows the parent -> current arrow and the stop-being-graded note when there is a parent", () => {
    render(<VersionChain promptId={12} parentPromptId={9} version={2} />);
    expect(screen.getByText(/Prompt 9/)).toBeInTheDocument();
    expect(screen.getByText(/Prompt 12/)).toBeInTheDocument();
    expect(screen.getByText(/stop being graded/i)).toBeInTheDocument();
  });

  it("shows just the prompt number when there is no parent", () => {
    render(<VersionChain promptId={5} parentPromptId={null} version={1} />);
    expect(screen.getByText(/Prompt 5/)).toBeInTheDocument();
    expect(screen.queryByText(/stop being graded/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- VersionChain`
Expected: FAIL — `Cannot find module '@/components/VersionChain'`

- [ ] **Step 3: Write `VersionChain.tsx`**

```tsx
// apps/web/src/components/VersionChain.tsx
export function VersionChain({ promptId, parentPromptId, version }: { promptId: number; parentPromptId: number | null; version: number }) {
  if (parentPromptId === null) {
    return <span>Prompt {promptId} (version {version})</span>;
  }
  return (
    <span>
      Prompt {parentPromptId} → Prompt {promptId} (version {version}) — <em>old versions keep their records and stop being graded</em>
    </span>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w apps/web -- VersionChain`
Expected: PASS (2 tests)

- [ ] **Step 5: Write `app/prompts/page.tsx`**

```tsx
// apps/web/app/prompts/page.tsx
"use client";
import { useEffect, useState } from "react";
import { VersionChain } from "@/components/VersionChain";

type Tab = "mine" | "drafts" | "following";

export default function PromptsPage() {
  const [tab, setTab] = useState<Tab>("mine");
  const [mine, setMine] = useState<any[] | null>(null);
  const [drafts, setDrafts] = useState<any[] | null>(null);

  useEffect(() => {
    fetch("/api/prompts?view=mine").then((r) => r.json()).then(setMine);
    fetch("/api/prompts?view=drafts").then((r) => r.json()).then(setDrafts);
  }, []);

  async function editAsNewVersion(promptId: number) {
    const res = await fetch(`/api/prompts/${promptId}/edit`, { method: "POST" });
    if (res.ok) {
      const { draft_id } = await res.json();
      window.location.href = `/drafts/${draft_id}`;
    }
  }

  async function retire(promptId: number) {
    const res = await fetch(`/api/prompts/${promptId}/retire`, { method: "POST" });
    if (res.ok) setMine((rows) => rows!.map((r) => (r.promptId === promptId ? { ...r, status: "retired" } : r)));
  }

  return (
    <main>
      <h1>My prompts</h1>
      <nav>
        <button type="button" onClick={() => setTab("mine")} aria-pressed={tab === "mine"}>Mine</button>
        <button type="button" onClick={() => setTab("following")} aria-pressed={tab === "following"} disabled>
          Following (needs sharing, not yet built)
        </button>
        <button type="button" onClick={() => setTab("drafts")} aria-pressed={tab === "drafts"}>Drafts</button>
      </nav>

      {tab === "mine" && (
        <table>
          <thead>
            <tr>
              <th>Prompt</th><th>Structure</th><th>Status</th><th>Graded</th><th>1-week return</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {(mine ?? []).map((p) => (
              <tr key={p.promptId}>
                <td><VersionChain promptId={p.promptId} parentPromptId={p.parentPromptId} version={p.version} /></td>
                <td>{p.structure}</td>
                <td>{p.status}</td>
                <td>week {p.gradedWeeks} of 13</td>
                <td>{p.lastHorizon1Return === null ? "not graded yet" : `${p.lastHorizon1Return.toFixed(2)}%`}</td>
                <td>
                  <a href={`/watchlists/${p.promptId}`}>Open watchlist</a>{" "}
                  {p.status === "confirmed" && (
                    <>
                      <button type="button" onClick={() => editAsNewVersion(p.promptId)}>Edit as new version</button>{" "}
                      <button type="button" onClick={() => retire(p.promptId)}>Retire</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "drafts" && (
        <ul>
          {(drafts ?? []).map((d) => (
            <li key={d.draftId}>
              Draft {d.draftId} — {d.blockedReason ?? "Ready to confirm"} — <a href={`/drafts/${d.draftId}`}>Continue</a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
```

- [ ] **Step 6: Build check**

Run: `npm run build -w apps/web`
Expected: builds with no type errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/apps/web/src/components/VersionChain.tsx frontend/apps/web/app/prompts frontend/apps/web/tests/components/VersionChain.test.tsx
git commit -m "feat(web): My prompts page — Mine/Drafts tabs, version chain, edit-as-new-version, retire"
```

---

### Task 13: Frontend — Validation card + entry timeline on the Watchlist page

**Files:**
- Create: `apps/web/src/components/ValidationCard.tsx`, `apps/web/src/components/EntryTimeline.tsx`
- Modify: `apps/web/app/watchlists/[watchlistId]/page.tsx`, `apps/web/src/server/watchlists.ts` (add `promptId` to the view if not already present — it already is)
- Test: `apps/web/tests/components/ValidationCard.test.tsx`

**Interfaces:**
- Produces: `ValidationCard({ gradedWeeks, horizons }: { gradedWeeks: number; horizons: { horizon: 1|2|3; n: number; ewReturn: number | null; hitRate: number | null }[] })` — renders "Graded week {gradedWeeks} of 13" always, and when `horizons` is empty, "No horizons graded yet" instead of an empty table (Review Focus item 5); otherwise one row per horizon with `n`/`ewReturn`/`hitRate`, plus the fixed note "arm picks vs Control only — near misses are not graded" (frontend plan §3.1). `EntryTimeline({ events }: { events: { type: string; fromValue: string | null; toValue: string | null; at: string }[] })` — renders one list item per event, oldest first, text-only (no color-only status per frontend plan §6). The watchlist page fetches `GET /api/prompts?view=mine` is NOT used here; instead it adds one more fetch, `GET /api/watchlists/:id` already returns `promptId` — the page additionally calls a new client-side fetch to a validation summary. Rather than add a second top-level route, **this task adds `validation` directly onto `getWatchlistView`'s return value** (import `getValidationSummary` into `watchlists.ts`), so the existing `GET /api/watchlists/:id` response grows one field: `validation: { gradedWeeks, horizons }`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/tests/components/ValidationCard.test.tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ValidationCard } from "@/components/ValidationCard";

describe("ValidationCard", () => {
  it("always shows graded week N of 13", () => {
    render(<ValidationCard gradedWeeks={5} horizons={[]} />);
    expect(screen.getByText(/graded week 5 of 13/i)).toBeInTheDocument();
  });

  it("shows 'no horizons graded yet' instead of an empty table when horizons is empty", () => {
    render(<ValidationCard gradedWeeks={5} horizons={[]} />);
    expect(screen.getByText(/no horizons graded yet/i)).toBeInTheDocument();
  });

  it("renders one row per horizon and the arm-picks-only note", () => {
    render(<ValidationCard gradedWeeks={13} horizons={[{ horizon: 1, n: 10, ewReturn: 2.5, hitRate: 0.6 }]} />);
    expect(screen.getByText(/2.50%/)).toBeInTheDocument();
    expect(screen.getByText(/arm picks vs Control only/i)).toBeInTheDocument();
    expect(screen.getByText(/near misses are not graded/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- ValidationCard`
Expected: FAIL — `Cannot find module '@/components/ValidationCard'`

- [ ] **Step 3: Write `ValidationCard.tsx` and `EntryTimeline.tsx`**

```tsx
// apps/web/src/components/ValidationCard.tsx
type Horizon = { horizon: 1 | 2 | 3; n: number; ewReturn: number | null; hitRate: number | null };

export function ValidationCard({ gradedWeeks, horizons }: { gradedWeeks: number; horizons: Horizon[] }) {
  return (
    <section>
      <h2>Validation</h2>
      <p>Graded week {gradedWeeks} of 13</p>
      <p><em>arm picks vs Control only — near misses are not graded</em></p>
      {horizons.length === 0 ? (
        <p>No horizons graded yet</p>
      ) : (
        <table>
          <thead><tr><th>Horizon</th><th>n</th><th>Return</th><th>Hit rate</th></tr></thead>
          <tbody>
            {horizons.map((h) => (
              <tr key={h.horizon}>
                <td>{h.horizon}w</td>
                <td>{h.n}</td>
                <td>{h.ewReturn === null ? "—" : `${h.ewReturn.toFixed(2)}%`}</td>
                <td>{h.hitRate === null ? "—" : `${(h.hitRate * 100).toFixed(0)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
```

```tsx
// apps/web/src/components/EntryTimeline.tsx
type Event = { type: string; fromValue: string | null; toValue: string | null; at: string };

const LABEL: Record<string, (e: Event) => string> = {
  status_changed: (e) => `Status changed: ${e.fromValue} → ${e.toValue}`,
  membership_changed: (e) => `Membership changed: ${e.fromValue} → ${e.toValue}`,
  dropped_from_screen: () => "Dropped from screen",
};

export function EntryTimeline({ events }: { events: Event[] }) {
  if (events.length === 0) return <p>No history yet</p>;
  return (
    <ul>
      {events.map((e, i) => (
        <li key={i}>{e.at} — {(LABEL[e.type] ?? ((ev: Event) => `${ev.type}: ${ev.fromValue} → ${ev.toValue}`))(e)}</li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w apps/web -- ValidationCard`
Expected: PASS (3 tests)

- [ ] **Step 5: Wire `getValidationSummary` into `getWatchlistView`**

```ts
// apps/web/src/server/watchlists.ts — add the import and the field
import { getValidationSummary } from "@/server/validations";

// ...inside getWatchlistView, after `conditions` / `lastRun` are built, before the final return:
  const validation = getValidationSummary(raw, prompt.prompt_id);

  return {
    watchlistId: watchlist.watchlist_id, promptId: prompt.prompt_id, title: prompt.title,
    structure: prompt.structure, hypothesis: prompt.hypothesis, killCriterion: prompt.kill_criterion,
    conditions, hasRiskCap: spec.risk_cap_pct !== null && spec.risk_cap_pct !== undefined,
    lastRun, entries, validation,
  };
```

- [ ] **Step 6: Wire `ValidationCard` and an entry-detail link into the Watchlist page**

```tsx
// apps/web/app/watchlists/[watchlistId]/page.tsx — add the import and render call
import { ValidationCard } from "@/components/ValidationCard";

// ...inside the returned JSX, after the <WatchlistTable .../> line:
      <ValidationCard gradedWeeks={view.validation.gradedWeeks} horizons={view.validation.horizons} />

// ...and give each table row a detail link (WatchlistTable itself is untouched;
// the page renders the link list below the table using the same `visibleEntries`
// it already computes):
      <ul>
        {visibleEntries.map((e: any) => (
          <li key={e.entryId}><a href={`/watchlists/${params.watchlistId}/entries/${e.entryId}`}>{e.symbol} — detail</a></li>
        ))}
      </ul>
```

- [ ] **Step 7: Run the full suite and a build check**

Run: `npm run test -w apps/web && npm run build -w apps/web`
Expected: PASS, builds with no type errors. `tests/watchlists.test.ts` (Phase 1) asserts on specific fields of `getWatchlistView`'s return value with `toEqual`-style checks on a subset — re-run it explicitly (`npm run test -w apps/web -- watchlists.test`) and, if it uses an exact `toEqual` on the whole object rather than `toMatchObject`, update it to expect the new `validation` field rather than loosening the assertion.

- [ ] **Step 8: Commit**

```bash
git add frontend/apps/web/src/components/ValidationCard.tsx frontend/apps/web/src/components/EntryTimeline.tsx frontend/apps/web/src/server/watchlists.ts frontend/apps/web/app/watchlists frontend/apps/web/tests/components/ValidationCard.test.tsx
git commit -m "feat(web): Validation card + entry timeline wired into the Watchlist page"
```

---

## What Phase 2 deliberately leaves out

- **`control_ew_return`** — Control's own forward-test return series isn't read into this app; the column stays NULL (Global Constraints). Wiring it is a follow-up once there's a decision on how this Next app reads the Python side's `results/forward_test/` store.
- **A real scheduler/worker/cron** — `scripts/run-weekly-jobs.ts` is a manual/cron-invoked CLI, matching D4 ("local for now") and the existing `scripts/weekly_selection_run.sh` pattern; no process manager or queue is introduced.
- **The personal note / "Remove from my watchlist" UI** — `watchlist_entries.user_note` and the detail page's note field are reachable (schema already supports it, `getEntryDetail` already returns `userNote`), but the edit form for it is left to whichever later task adds the full detail panel described in frontend plan §3.1, consistent with Phase 1's own deferral of this exact item.
- **Prompt compiler, sharing/Explore/Follow, multi-user login** — frontend plan §7 P3/P4, each getting its own plan doc.

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-10-06-prompt-screener-frontend-p2.md`. Two more plans (P3: prompt compiler; P4: sharing + multi-user login) are being written next, per your "all of P2, P3, P4" scope choice — I'll hand off all three together once P4 is done, so you can review and choose execution approach (subagent-driven vs. native) once for the whole set, rather than three separate times.
