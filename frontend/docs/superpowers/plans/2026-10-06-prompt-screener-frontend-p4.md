# Prompt Screener — Frontend Phase 4 Implementation Plan (sharing + multi-user login)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build frontend-plan §7 P4 — visibility (private/shared), Explore, Follow/Unfollow, Copy to my drafts, the My-prompts "Following" tab, and the multi-user login that all of this depends on (frontend plan §2: "Login appears only once a second user exists, which is also when Explore becomes useful").

**Architecture:** Sessions are a signed cookie (HMAC-SHA256 over `userId.expiresAtMs`, keyed by a `SESSION_SECRET` in `.env.local`) — backend plan §8.4's DDL has no `sessions` table, and §9's "keys are kept in `.env.local`" is read as covering exactly this signing secret, so this plan adds no new table for auth, only two columns (`prompts.visibility`, `prompts.copied_from_prompt_id`/`prompt_drafts.copied_from_prompt_id`) exactly as frontend plan §4 lists them. Every route built in Phases 1–3 that hardcoded `OWNER_USER_ID = 1` is refactored to read the real current user — in single-user mode (only one row in `users`) this still resolves automatically with no cookie needed at all, so none of Phases 1–3's existing tests or manual flows change behavior until a second user actually signs up.

**Tech Stack:** Adds `argon2` (password hashing) to `apps/web`'s dependencies. Everything else matches Phases 1–3.

**Spec:** `docs/prompt-screener-frontend-plan.md` v3.2 §2 (login timing), §3.3 (Following tab), §3.4 (Explore), §4 (backend additions — visibility, copied_from_prompt_id, follow-is-a-watchlist-row, access rule, endpoints, follower count, login); `docs/prompt-screener-backend-plan.md` v3.2 §8.7 (users on a local install).

## Global Constraints

- **No new `sessions` table.** A session is a signed cookie; `verifySessionCookie` either returns a valid, unexpired `userId` or `null` — there is nothing to look up or revoke server-side in this plan (logging out just clears the cookie).
- **Single-user mode is unchanged from Phases 1–3.** With exactly one row in `users`, `getCurrentUserId` resolves to that user whether or not a cookie is present — this is the exact behavior every existing Phase 1–3 test already relies on via its hardcoded `OWNER_USER_ID = 1`; this plan must not break any of them. Login becomes mandatory the instant a second user exists (frontend plan §2), not before.
- **Only three existing routes change their source of `userId`**: `POST /api/drafts`, `GET /api/prompts`, `POST /api/prompts/:promptId/edit` (the only three that ever hardcoded `OWNER_USER_ID`). Every other Phase 1–3 route is already scoped by an id in the URL (`draftId`/`watchlistId`/`promptId`) and needs no change.
- **Passwords are hashed with `argon2id`** (backend plan §8.7) and never stored, logged, or returned in plaintext by any route.
- **Visibility/follow/copy never touch grading.** `runWeeklyScreen`/`runSelectEntry`/`runValidatePrior` (Phase 2) are not modified by this plan. The one real intersection — a just-unshared prompt's followers should stop being seeded — already works for free, because `runWeeklyScreen` (Phase 2, Task 3) already filters `WHERE prompt_id = ? AND archived_at IS NULL`; this plan only needs to set `archived_at`, never to touch `runWeeklyScreen` itself.
- **Unfollow and un-sharing are never destructive.** Both set `archived_at`; neither ever issues a `DELETE`. Re-following a still-shared prompt reuses the existing (possibly archived) watchlist row — the Phase 1 `UNIQUE(user_id, prompt_id)` index means a second `INSERT` would fail outright, so `followPrompt` must be an upsert by construction, not an oversight to catch later.
- **Followers never gain write access to a prompt's conditions, and following never registers a second Test arm.** A follower's watchlist is seeded from the owner's own `runs`/`run_results` (Phase 2's `runWeeklyScreen` already does this for every watchlist on the prompt, follower or not) — this plan's `followPrompt` only ever inserts/updates `watchlists`/`watchlist_entries` rows, never `prompts`/`prompt_conditions`/`runs`.
- **Access is enforced server-side, not just hidden in the UI.** `canAccess(prompt, userId)` (owner or `visibility = 'shared'`) gates `followPrompt`, `copyPromptToDraft`, and `listExplore` directly; a private prompt's data is never included in an Explore response or a follow/copy success, regardless of what the UI does or doesn't show.

## Review Focus

- **A non-owner calls follow/copy on a prompt that is `private`.** Expected: 403 (`ForbiddenError`), and the response body never includes the prompt's title/conditions — not a silent success, not a leak. Covered in Task 8/9 and Task 14.
- **An owner sets a `shared` prompt back to `private` while it has followers.** Expected: every non-owner watchlist for that prompt gets `archived_at` set in the same call; the owner's own watchlist is untouched; no row is deleted. Covered in Task 7 and Task 14.
- **A user unfollows, then re-follows the same still-shared prompt later.** Expected: the exact same `watchlist_id` is reused (`archived_at` cleared) — never a second `INSERT` that would hit the `UNIQUE(user_id, prompt_id)` index, never a duplicate watchlist. Covered in Task 8.
- **The app is in single-user mode and a request carries no `session` cookie at all** (every request Phases 1–3 ever made). Expected: every refactored route still resolves to user 1 and behaves exactly as before — never a 401. Covered in Task 4 and Task 6.
- **A second user signs up, and a later request from the first user's browser carries no cookie** (e.g. an old tab from before signup). Expected: now a 401 — single-user auto-login stops applying the instant `users` has more than one row, which is the precise moment frontend plan §2 says login "appears." Covered in Task 4 and Task 6.

---

## File Structure

```
frontend/apps/web/
  package.json                                       (MODIFY — add argon2)
  src/server/db/
    migrations/0004_sharing.sql                        (NEW)
    schema.ts                                          (MODIFY — prompts.visibility/copiedFromPromptId, promptDrafts.copiedFromPromptId)
  src/server/
    drafts.ts                                          (MODIFY — createDraft accepts copiedFromPromptId, DraftRow exposes it)
    confirm.ts                                          (MODIFY — carries copiedFromPromptId onto the new prompt row)
    access.ts                                          (NEW — ForbiddenError, canAccess)
    auth/
      session.ts                                       (NEW)
      users.ts                                         (NEW)
      currentUser.ts                                    (NEW)
    visibility.ts                                       (NEW)
    follow.ts                                           (NEW)
    copyPrompt.ts                                       (NEW)
    explore.ts                                          (NEW)
    listPrompts.ts                                      (MODIFY — adds view: "following")
  app/
    api/auth/signup/route.ts                            (NEW)
    api/auth/login/route.ts                             (NEW)
    api/auth/logout/route.ts                            (NEW)
    api/auth/me/route.ts                                (NEW)
    api/drafts/route.ts                                 (MODIFY — getCurrentUserId instead of OWNER_USER_ID)
    api/prompts/route.ts                                (MODIFY — same, plus view=following)
    api/prompts/[promptId]/edit/route.ts                (MODIFY — same)
    api/prompts/[promptId]/visibility/route.ts          (NEW — PATCH)
    api/prompts/[promptId]/follow/route.ts              (NEW — POST, DELETE)
    api/prompts/[promptId]/copy/route.ts                (NEW — POST)
    api/explore/route.ts                                (NEW — GET)
    login/page.tsx                                      (NEW)
    signup/page.tsx                                     (NEW)
    explore/page.tsx                                    (NEW)
    prompts/page.tsx                                    (MODIFY — Following tab wired to real data, Share toggle)
  src/components/
    AuthGate.tsx                                        (NEW)
  tests/
    migrate-p4.test.ts
    session.test.ts
    users.test.ts
    currentUser.test.ts
    auth-routes.test.ts
    route-refactor.test.ts
    visibility.test.ts
    follow.test.ts
    copyPrompt.test.ts
    explore.test.ts
    confirm-lineage.test.ts
    access-rules.test.ts
    components/AuthGate.test.tsx
```

---

### Task 1: Migration `0004_sharing.sql` + `schema.ts` + `drafts.ts`/`confirm.ts` lineage field

**Files:**
- Create: `apps/web/src/server/db/migrations/0004_sharing.sql`
- Modify: `apps/web/src/server/db/schema.ts`, `apps/web/src/server/drafts.ts`, `apps/web/src/server/confirm.ts`
- Test: `apps/web/tests/migrate-p4.test.ts`, `apps/web/tests/confirm-lineage.test.ts`

**Interfaces:**
- Produces: `prompts.visibility` (`'private'|'shared'`, default `'private'`), `prompts.copied_from_prompt_id`, `prompt_drafts.copied_from_prompt_id`. `createDraft(raw, { userId, copiedFromPromptId? })` gains the optional field. `DraftRow` gains `copiedFromPromptId: number | null`. `confirmDraft` (Phase 1–3) now also writes `copied_from_prompt_id` onto the new `prompts` row whenever the draft carries one, leaving everything else about confirm unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/tests/migrate-p4.test.ts
import { describe, expect, it } from "vitest";
import { createTestDb } from "@/server/db/test-db";

describe("0004_sharing migration", () => {
  it("defaults prompts.visibility to private", () => {
    const raw = createTestDb();
    const userId = (raw.prepare("INSERT INTO users (display_name, role, status, created_at) VALUES ('U', 'member', 'active', '2026-01-01')").run()).lastInsertRowid;
    raw.prepare(`INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (1, ?, 'x', 'confirmed', '2026-01-01', '2026-01-01')`).run(userId);
    raw.prepare(
      `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, confirmed_at)
       VALUES (1, ?, 1, 'T', 'x', 'literal', '{}', 'h', 'confirmed', 1, 'h', 'k', '2026-01-01')`
    ).run(userId);
    const row = raw.prepare("SELECT visibility FROM prompts WHERE prompt_id = 1").get() as any;
    expect(row.visibility).toBe("private");
  });

  it("rejects a visibility value outside the enum", () => {
    const raw = createTestDb();
    expect(() => raw.prepare("UPDATE prompts SET visibility = 'public' WHERE prompt_id = 1").run()).toThrow();
  });
});
```

```ts
// apps/web/tests/confirm-lineage.test.ts
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

describe("confirmDraft — copied_from_prompt_id lineage", () => {
  it("carries the draft's copiedFromPromptId onto the new prompt row", async () => {
    const raw = createTestDb();
    const userId = ensureOwnerUser(raw);
    const { draftId } = createDraft(raw, { userId, copiedFromPromptId: 15 });
    updateDraft(raw, draftId, { structure: "literal", specJson: JSON.stringify(SPEC), hypothesis: "h", killCriterion: "k" });
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ candidates: [], applied_steps: [], funnel: [], sector_view: [] }) });
    const { promptId } = await confirmDraft(raw, draftId, "2026-10-02", fetchFn as any);
    const row = raw.prepare("SELECT copied_from_prompt_id FROM prompts WHERE prompt_id = ?").get(promptId) as any;
    expect(row.copied_from_prompt_id).toBe(15);
  });

  it("leaves copied_from_prompt_id NULL for an ordinary (non-copied) draft", async () => {
    const raw = createTestDb();
    const userId = ensureOwnerUser(raw);
    const { draftId } = createDraft(raw, { userId });
    updateDraft(raw, draftId, { structure: "literal", specJson: JSON.stringify(SPEC), hypothesis: "h", killCriterion: "k" });
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ candidates: [], applied_steps: [], funnel: [], sector_view: [] }) });
    const { promptId } = await confirmDraft(raw, draftId, "2026-10-02", fetchFn as any);
    const row = raw.prepare("SELECT copied_from_prompt_id FROM prompts WHERE prompt_id = ?").get(promptId) as any;
    expect(row.copied_from_prompt_id).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -w apps/web -- migrate-p4.test confirm-lineage.test`
Expected: FAIL — the column/field don't exist yet.

- [ ] **Step 3: Write `0004_sharing.sql`**

```sql
-- apps/web/src/server/db/migrations/0004_sharing.sql
PRAGMA foreign_keys = ON;

ALTER TABLE prompts ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','shared'));
ALTER TABLE prompts ADD COLUMN copied_from_prompt_id INTEGER REFERENCES prompts(prompt_id);
ALTER TABLE prompt_drafts ADD COLUMN copied_from_prompt_id INTEGER REFERENCES prompts(prompt_id);
```

- [ ] **Step 4: Update `schema.ts`**

```ts
// apps/web/src/server/db/schema.ts
// In the existing prompts sqliteTable(...), add:
  visibility: text("visibility").notNull(),
  copiedFromPromptId: integer("copied_from_prompt_id"),

// In the existing promptDrafts sqliteTable(...), add:
  copiedFromPromptId: integer("copied_from_prompt_id"),
```

- [ ] **Step 5: Extend `drafts.ts`**

```ts
// apps/web/src/server/drafts.ts
export type DraftRow = {
  // ...all existing fields unchanged (including Phase 3's needsInput/sourcePhrases/unsupported)...
  copiedFromPromptId: number | null;
};

function rowToDraft(row: any): DraftRow {
  return {
    // ...all existing fields unchanged...
    copiedFromPromptId: row.copied_from_prompt_id,
  };
}

export function createDraft(
  raw: Database.Database,
  { userId, copiedFromPromptId }: { userId: number; copiedFromPromptId?: number }
): { draftId: number } {
  const now = new Date().toISOString();
  const info = raw
    .prepare(
      `INSERT INTO prompt_drafts (user_id, copied_from_prompt_id, prompt_text, status, created_at, updated_at)
       VALUES (?, ?, '', 'open', ?, ?)`
    )
    .run(userId, copiedFromPromptId ?? null, now, now);
  return { draftId: Number(info.lastInsertRowid) };
}
```

- [ ] **Step 6: Extend `confirm.ts`**

```ts
// apps/web/src/server/confirm.ts
// Inside createPromptAndWatchlist's INSERT INTO prompts, add copied_from_prompt_id as a column and bind draft.copiedFromPromptId:
    promptInfo = raw
      .prepare(
        `INSERT INTO prompts
           (owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash,
            status, parent_prompt_id, version, hypothesis, kill_criterion, copied_from_prompt_id, confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        draft.userId, draftId, draft.title ?? `Prompt from draft ${draftId}`, draft.promptText,
        draft.structure, specJson, specHash, parent ? parent.prompt_id : null, parent ? parent.version + 1 : 1,
        draft.hypothesis, draft.killCriterion, draft.copiedFromPromptId, now
      );
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm run test -w apps/web -- migrate-p4.test confirm-lineage.test drafts.test confirm.test confirm-versioning.test`
Expected: PASS, with every prior Phase 1–3 confirm test unaffected (they never pass `copiedFromPromptId`, which defaults to `undefined` → bound as `null`).

- [ ] **Step 8: Commit**

```bash
git add frontend/apps/web/src/server/db/migrations/0004_sharing.sql frontend/apps/web/src/server/db/schema.ts frontend/apps/web/src/server/drafts.ts frontend/apps/web/src/server/confirm.ts frontend/apps/web/tests/migrate-p4.test.ts frontend/apps/web/tests/confirm-lineage.test.ts
git commit -m "feat(web): prompts.visibility + copied_from_prompt_id lineage columns, wired into createDraft/confirmDraft"
```

---

### Task 2: `auth/session.ts` — signed session cookie

**Files:**
- Create: `apps/web/src/server/auth/session.ts`
- Test: `apps/web/tests/session.test.ts`

**Interfaces:**
- Produces: `createSessionCookie(userId: number, now?: () => number): string`; `verifySessionCookie(cookie: string | null | undefined, now?: () => number): number | null`. Both read `process.env.SESSION_SECRET` lazily (only when actually signing/verifying a non-empty cookie), throwing a clear error if it's unset.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/session.test.ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createSessionCookie, verifySessionCookie } from "@/server/auth/session";

describe("session cookie", () => {
  const ORIGINAL = process.env.SESSION_SECRET;
  beforeEach(() => { process.env.SESSION_SECRET = "test-secret"; });
  afterEach(() => { process.env.SESSION_SECRET = ORIGINAL; });

  it("round-trips a userId", () => {
    const cookie = createSessionCookie(7);
    expect(verifySessionCookie(cookie)).toBe(7);
  });

  it("rejects a tampered cookie", () => {
    const cookie = createSessionCookie(7);
    const tampered = cookie.slice(0, -1) + (cookie.endsWith("A") ? "B" : "A");
    expect(verifySessionCookie(tampered)).toBeNull();
  });

  it("rejects an expired cookie", () => {
    let fakeNow = 1_000_000;
    const cookie = createSessionCookie(7, () => fakeNow);
    fakeNow += 31 * 24 * 60 * 60 * 1000; // 31 days later
    expect(verifySessionCookie(cookie, () => fakeNow)).toBeNull();
  });

  it("returns null for a missing cookie without throwing", () => {
    expect(verifySessionCookie(null)).toBeNull();
    expect(verifySessionCookie(undefined)).toBeNull();
  });

  it("throws a clear error when SESSION_SECRET is unset and a cookie must actually be signed", () => {
    delete process.env.SESSION_SECRET;
    expect(() => createSessionCookie(7)).toThrow(/SESSION_SECRET/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- session.test`
Expected: FAIL — `Cannot find module '@/server/auth/session'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/server/auth/session.ts
import { createHmac, timingSafeEqual } from "node:crypto";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is not set in .env.local — required once more than one user exists");
  return s;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function createSessionCookie(userId: number, now: () => number = Date.now): string {
  const expiresAtMs = now() + SESSION_TTL_MS;
  const payload = `${userId}.${expiresAtMs}`;
  return `${payload}.${sign(payload)}`;
}

export function verifySessionCookie(cookie: string | null | undefined, now: () => number = Date.now): number | null {
  if (!cookie) return null;
  const parts = cookie.split(".");
  if (parts.length !== 3) return null;
  const [userIdStr, expiresAtStr, signature] = parts;

  let expected: string;
  try {
    expected = sign(`${userIdStr}.${expiresAtStr}`);
  } catch {
    return null;
  }

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const expiresAtMs = Number(expiresAtStr);
  if (Number.isNaN(expiresAtMs) || now() > expiresAtMs) return null;

  const userId = Number(userIdStr);
  return Number.isNaN(userId) ? null : userId;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w apps/web -- session.test`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/src/server/auth/session.ts frontend/apps/web/tests/session.test.ts
git commit -m "feat(web): signed session cookie (HMAC-SHA256, SESSION_SECRET) — no sessions table"
```

---

### Task 3: `auth/users.ts` — `createUser`/`verifyPassword` with argon2id

**Files:**
- Create: `apps/web/src/server/auth/users.ts`
- Modify: `apps/web/package.json` (add `argon2`)
- Test: `apps/web/tests/users.test.ts`

**Interfaces:**
- Produces: `createUser(raw, { displayName, email, password }): Promise<{ userId: number }>` — throws if the email is already taken; `verifyPassword(raw, { email, password }): Promise<{ userId: number } | null>` — `null` for a wrong password, a disabled user, or an unknown email (no distinction in the error, to avoid leaking which emails exist).

- [ ] **Step 1: Add the dependency**

```json
{ "dependencies": { "argon2": "0.41.1" } }
```

(Merge into the existing `dependencies` block — do not remove any existing entry.) Run (from `frontend/`): `npm install`.

- [ ] **Step 2: Write the failing test**

```ts
// apps/web/tests/users.test.ts
import { describe, expect, it } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { createUser, verifyPassword } from "@/server/auth/users";

describe("createUser / verifyPassword", () => {
  it("creates a user with a hashed password (never plaintext) and verifies the correct password", async () => {
    const raw = createTestDb();
    const { userId } = await createUser(raw, { displayName: "Second User", email: "second@example.com", password: "correct-horse" });
    expect(userId).toBeGreaterThan(0);

    const row = raw.prepare("SELECT password_hash FROM users WHERE user_id = ?").get(userId) as any;
    expect(row.password_hash).not.toBe("correct-horse");
    expect(row.password_hash.length).toBeGreaterThan(20);

    const result = await verifyPassword(raw, { email: "second@example.com", password: "correct-horse" });
    expect(result).toEqual({ userId });
  });

  it("rejects the wrong password", async () => {
    const raw = createTestDb();
    await createUser(raw, { displayName: "U", email: "u@example.com", password: "right" });
    const result = await verifyPassword(raw, { email: "u@example.com", password: "wrong" });
    expect(result).toBeNull();
  });

  it("rejects an unknown email the same way as a wrong password (no existence leak)", async () => {
    const raw = createTestDb();
    const result = await verifyPassword(raw, { email: "nobody@example.com", password: "x" });
    expect(result).toBeNull();
  });

  it("refuses to create a second user with the same email", async () => {
    const raw = createTestDb();
    await createUser(raw, { displayName: "First", email: "dup@example.com", password: "x" });
    await expect(createUser(raw, { displayName: "Second", email: "dup@example.com", password: "y" })).rejects.toThrow(/already exists/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -w apps/web -- users.test`
Expected: FAIL — `Cannot find module '@/server/auth/users'`

- [ ] **Step 4: Write the implementation**

```ts
// apps/web/src/server/auth/users.ts
import type Database from "better-sqlite3";
import * as argon2 from "argon2";

export async function createUser(
  raw: Database.Database,
  { displayName, email, password }: { displayName: string; email: string; password: string }
): Promise<{ userId: number }> {
  const existing = raw.prepare("SELECT user_id FROM users WHERE email = ?").get(email);
  if (existing) throw new Error(`a user with email ${email} already exists`);

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const now = new Date().toISOString();
  const info = raw
    .prepare("INSERT INTO users (display_name, email, password_hash, role, status, created_at) VALUES (?, ?, ?, 'member', 'active', ?)")
    .run(displayName, email, passwordHash, now);
  return { userId: Number(info.lastInsertRowid) };
}

export async function verifyPassword(
  raw: Database.Database,
  { email, password }: { email: string; password: string }
): Promise<{ userId: number } | null> {
  const row = raw.prepare("SELECT user_id, password_hash FROM users WHERE email = ? AND status = 'active'").get(email) as
    | { user_id: number; password_hash: string | null }
    | undefined;
  if (!row || !row.password_hash) return null;

  const ok = await argon2.verify(row.password_hash, password);
  return ok ? { userId: row.user_id } : null;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -w apps/web -- users.test`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add frontend/apps/web/package.json frontend/apps/web/src/server/auth/users.ts frontend/apps/web/tests/users.test.ts frontend/package-lock.json
git commit -m "feat(web): createUser/verifyPassword — argon2id password hashing"
```

---

### Task 4: `auth/currentUser.ts` — `getCurrentUserId`, single-user fallback

**Files:**
- Create: `apps/web/src/server/auth/currentUser.ts`
- Test: `apps/web/tests/currentUser.test.ts`

**Interfaces:**
- Produces: `AuthRequiredError`; `getCurrentUserId(raw: Database.Database, req: Request): number` — reads the `session` cookie from `req.headers.get("cookie")`; in single-user mode (`users` has exactly one row), returns that user whether or not a valid cookie is present; otherwise requires a valid, unexpired session cookie or throws `AuthRequiredError`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/currentUser.test.ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { createSessionCookie } from "@/server/auth/session";
import { getCurrentUserId, AuthRequiredError } from "@/server/auth/currentUser";

function reqWithCookie(cookie?: string) {
  return new Request("http://localhost/api/whatever", { headers: cookie ? { cookie: `session=${cookie}` } : {} });
}

describe("getCurrentUserId", () => {
  const ORIGINAL = process.env.SESSION_SECRET;
  beforeEach(() => { process.env.SESSION_SECRET = "test-secret"; });
  afterEach(() => { process.env.SESSION_SECRET = ORIGINAL; });

  it("single-user mode: resolves to the only user even with no cookie at all", () => {
    const raw = createTestDb();
    const userId = ensureOwnerUser(raw);
    expect(getCurrentUserId(raw, reqWithCookie())).toBe(userId);
  });

  it("single-user mode: a valid cookie for that same user still works", () => {
    const raw = createTestDb();
    const userId = ensureOwnerUser(raw);
    expect(getCurrentUserId(raw, reqWithCookie(createSessionCookie(userId)))).toBe(userId);
  });

  it("multi-user mode: throws AuthRequiredError with no cookie", () => {
    const raw = createTestDb();
    ensureOwnerUser(raw);
    raw.prepare("INSERT INTO users (display_name, email, role, status, created_at) VALUES ('Second', 's@example.com', 'member', 'active', '2026-01-01')").run();
    expect(() => getCurrentUserId(raw, reqWithCookie())).toThrow(AuthRequiredError);
  });

  it("multi-user mode: a valid cookie resolves to that cookie's user", () => {
    const raw = createTestDb();
    ensureOwnerUser(raw);
    const info = raw.prepare("INSERT INTO users (display_name, email, role, status, created_at) VALUES ('Second', 's@example.com', 'member', 'active', '2026-01-01')").run();
    const secondId = Number(info.lastInsertRowid);
    expect(getCurrentUserId(raw, reqWithCookie(createSessionCookie(secondId)))).toBe(secondId);
  });

  it("multi-user mode: an expired/tampered cookie throws, never silently falls back to user 1", () => {
    const raw = createTestDb();
    ensureOwnerUser(raw);
    raw.prepare("INSERT INTO users (display_name, email, role, status, created_at) VALUES ('Second', 's@example.com', 'member', 'active', '2026-01-01')").run();
    expect(() => getCurrentUserId(raw, reqWithCookie("garbage.not.valid"))).toThrow(AuthRequiredError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- currentUser.test`
Expected: FAIL — `Cannot find module '@/server/auth/currentUser'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/server/auth/currentUser.ts
import type Database from "better-sqlite3";
import { verifySessionCookie } from "@/server/auth/session";

export class AuthRequiredError extends Error {
  constructor() { super("sign in required"); }
}

function parseCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function onlyUserId(raw: Database.Database): number | null {
  const only = raw.prepare("SELECT user_id FROM users ORDER BY user_id LIMIT 1").get() as { user_id: number } | undefined;
  return only ? only.user_id : null;
}

export function getCurrentUserId(raw: Database.Database, req: Request): number {
  const userCount = (raw.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  const cookie = parseCookie(req.headers.get("cookie"), "session");

  if (userCount <= 1) {
    const resolved = cookie ? verifySessionCookie(cookie) : null;
    const fallback = onlyUserId(raw);
    if (resolved !== null) return resolved;
    if (fallback !== null) return fallback;
    throw new AuthRequiredError();
  }

  const sessionUserId = verifySessionCookie(cookie);
  if (sessionUserId === null) throw new AuthRequiredError();
  return sessionUserId;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w apps/web -- currentUser.test`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/src/server/auth/currentUser.ts frontend/apps/web/tests/currentUser.test.ts
git commit -m "feat(web): getCurrentUserId — single-user auto-login, mandatory session once a second user exists"
```

---

### Task 5: Auth routes — signup, login, logout, me

**Files:**
- Create: `apps/web/app/api/auth/signup/route.ts`, `apps/web/app/api/auth/login/route.ts`, `apps/web/app/api/auth/logout/route.ts`, `apps/web/app/api/auth/me/route.ts`
- Test: `apps/web/tests/auth-routes.test.ts`

**Interfaces:**
- `POST /api/auth/signup` `{displayName, email, password}` → `201 {user_id}` + `Set-Cookie: session=...`. `POST /api/auth/login` `{email, password}` → `200 {user_id}` + `Set-Cookie`, or `401`. `POST /api/auth/logout` → `200 {ok: true}` + a cookie that clears it (`Max-Age=0`). `GET /api/auth/me` → `{multiUser: boolean, currentUser: {userId, displayName, email} | null}` — never throws even when signed out, so the frontend can always call it to decide whether to show a login gate.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/auth-routes.test.ts
import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";

vi.mock("@/server/db/client", () => ({ db: vi.fn() }));

describe("auth routes", () => {
  it("POST /api/auth/signup creates a user and sets a session cookie", async () => {
    process.env.SESSION_SECRET = "test-secret";
    const { db } = await import("@/server/db/client");
    const raw = createTestDb();
    ensureOwnerUser(raw);
    (db as any).mockReturnValue(raw);

    const { POST } = await import("@/app/api/auth/signup/route");
    const res = await POST(new Request("http://localhost/api/auth/signup", { method: "POST", body: JSON.stringify({ displayName: "Second", email: "s@example.com", password: "x" }) }));
    expect(res.status).toBe(201);
    expect(res.headers.get("set-cookie")).toMatch(/^session=/);
  });

  it("GET /api/auth/me reports multiUser: false and the sole user when only one exists", async () => {
    const { db } = await import("@/server/db/client");
    const raw = createTestDb();
    ensureOwnerUser(raw);
    (db as any).mockReturnValue(raw);

    const { GET } = await import("@/app/api/auth/me/route");
    const res = await GET(new Request("http://localhost/api/auth/me"));
    const body = await res.json();
    expect(body.multiUser).toBe(false);
    expect(body.currentUser).not.toBeNull();
  });

  it("POST /api/auth/login rejects a wrong password with 401", async () => {
    const { db } = await import("@/server/db/client");
    const raw = createTestDb();
    const { createUser } = await import("@/server/auth/users");
    await createUser(raw, { displayName: "U", email: "u@example.com", password: "right" });
    (db as any).mockReturnValue(raw);

    const { POST } = await import("@/app/api/auth/login/route");
    const res = await POST(new Request("http://localhost/api/auth/login", { method: "POST", body: JSON.stringify({ email: "u@example.com", password: "wrong" }) }));
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- auth-routes.test`
Expected: FAIL — the route modules don't exist yet.

- [ ] **Step 3: Write the four routes**

```ts
// apps/web/app/api/auth/signup/route.ts
import { db } from "@/server/db/client";
import { createUser } from "@/server/auth/users";
import { createSessionCookie } from "@/server/auth/session";

export async function POST(req: Request) {
  const { displayName, email, password } = await req.json();
  try {
    const { userId } = await createUser(db(), { displayName, email, password });
    const cookie = createSessionCookie(userId);
    return Response.json({ user_id: userId }, { status: 201, headers: { "Set-Cookie": `session=${cookie}; HttpOnly; Path=/; SameSite=Lax` } });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 409 });
  }
}
```

```ts
// apps/web/app/api/auth/login/route.ts
import { db } from "@/server/db/client";
import { verifyPassword } from "@/server/auth/users";
import { createSessionCookie } from "@/server/auth/session";

export async function POST(req: Request) {
  const { email, password } = await req.json();
  const result = await verifyPassword(db(), { email, password });
  if (!result) return Response.json({ error: "invalid email or password" }, { status: 401 });
  const cookie = createSessionCookie(result.userId);
  return Response.json({ user_id: result.userId }, { headers: { "Set-Cookie": `session=${cookie}; HttpOnly; Path=/; SameSite=Lax` } });
}
```

```ts
// apps/web/app/api/auth/logout/route.ts
export async function POST() {
  return Response.json({ ok: true }, { headers: { "Set-Cookie": "session=; HttpOnly; Path=/; Max-Age=0" } });
}
```

```ts
// apps/web/app/api/auth/me/route.ts
import { db } from "@/server/db/client";
import { getCurrentUserId, AuthRequiredError } from "@/server/auth/currentUser";

export async function GET(req: Request) {
  const raw = db();
  const userCount = (raw.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  try {
    const userId = getCurrentUserId(raw, req);
    const user = raw.prepare("SELECT user_id, display_name, email FROM users WHERE user_id = ?").get(userId) as any;
    return Response.json({ multiUser: userCount > 1, currentUser: { userId: user.user_id, displayName: user.display_name, email: user.email } });
  } catch (err) {
    if (err instanceof AuthRequiredError) return Response.json({ multiUser: userCount > 1, currentUser: null });
    throw err;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w apps/web -- auth-routes.test`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/app/api/auth frontend/apps/web/tests/auth-routes.test.ts
git commit -m "feat(web): auth routes — signup, login, logout, me"
```

---

### Task 6: Refactor the three `OWNER_USER_ID`-hardcoded routes

**Files:**
- Modify: `apps/web/app/api/drafts/route.ts`, `apps/web/app/api/prompts/route.ts`, `apps/web/app/api/prompts/[promptId]/edit/route.ts`
- Test: `apps/web/tests/route-refactor.test.ts`

**Interfaces:**
- No change to any route's response shape or URL — only the source of `userId` changes, from the `OWNER_USER_ID = 1` constant to `getCurrentUserId(db(), req)`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/route-refactor.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";

vi.mock("@/server/db/client", () => ({ db: vi.fn() }));

describe("POST /api/drafts uses getCurrentUserId", () => {
  const ORIGINAL = process.env.SESSION_SECRET;
  beforeEach(() => { process.env.SESSION_SECRET = "test-secret"; });
  afterEach(() => { process.env.SESSION_SECRET = ORIGINAL; });

  it("single-user mode: still works with no cookie, same as Phase 1 behavior", async () => {
    const { db } = await import("@/server/db/client");
    const raw = createTestDb();
    const userId = ensureOwnerUser(raw);
    (db as any).mockReturnValue(raw);

    const { POST } = await import("@/app/api/drafts/route");
    const res = await POST(new Request("http://localhost/api/drafts", { method: "POST" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    const row = raw.prepare("SELECT user_id FROM prompt_drafts WHERE draft_id = ?").get(body.draft_id) as any;
    expect(row.user_id).toBe(userId);
  });

  it("multi-user mode: a request with no session is rejected, not silently assigned to user 1", async () => {
    const { db } = await import("@/server/db/client");
    const raw = createTestDb();
    ensureOwnerUser(raw);
    raw.prepare("INSERT INTO users (display_name, email, role, status, created_at) VALUES ('Second', 's@example.com', 'member', 'active', '2026-01-01')").run();
    (db as any).mockReturnValue(raw);

    const { POST } = await import("@/app/api/drafts/route");
    const res = await POST(new Request("http://localhost/api/drafts", { method: "POST" }));
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- route-refactor.test`
Expected: FAIL — `POST /api/drafts` currently always succeeds (hardcoded `OWNER_USER_ID`), so the second case fails.

- [ ] **Step 3: Rewrite the three routes**

```ts
// apps/web/app/api/drafts/route.ts
import { db } from "@/server/db/client";
import { createDraft } from "@/server/drafts";
import { getCurrentUserId, AuthRequiredError } from "@/server/auth/currentUser";

export async function POST(req: Request) {
  try {
    const userId = getCurrentUserId(db(), req);
    const { draftId } = createDraft(db(), { userId });
    return Response.json({ draft_id: draftId }, { status: 201 });
  } catch (err) {
    if (err instanceof AuthRequiredError) return Response.json({ error: "sign in required" }, { status: 401 });
    throw err;
  }
}
```

```ts
// apps/web/app/api/prompts/route.ts
import { db } from "@/server/db/client";
import { listPrompts } from "@/server/listPrompts";
import { getCurrentUserId, AuthRequiredError } from "@/server/auth/currentUser";

export async function GET(req: Request) {
  try {
    const userId = getCurrentUserId(db(), req);
    const viewParam = new URL(req.url).searchParams.get("view");
    const view = viewParam === "drafts" ? "drafts" : viewParam === "following" ? "following" : "mine";
    return Response.json(listPrompts(db(), { userId, view }));
  } catch (err) {
    if (err instanceof AuthRequiredError) return Response.json({ error: "sign in required" }, { status: 401 });
    throw err;
  }
}
```

```ts
// apps/web/app/api/prompts/[promptId]/edit/route.ts
import { db } from "@/server/db/client";
import { createEditDraft } from "@/server/prompts";
import { getCurrentUserId, AuthRequiredError } from "@/server/auth/currentUser";

export async function POST(req: Request, { params }: { params: { promptId: string } }) {
  try {
    const userId = getCurrentUserId(db(), req);
    const { draftId } = createEditDraft(db(), { promptId: Number(params.promptId), userId });
    return Response.json({ draft_id: draftId }, { status: 201 });
  } catch (err) {
    if (err instanceof AuthRequiredError) return Response.json({ error: "sign in required" }, { status: 401 });
    const status = /not found/.test((err as Error).message) ? 404 : 409;
    return Response.json({ error: (err as Error).message }, { status });
  }
}
```

(`listPrompts`'s `view: "following"` is implemented in Task 10 — until then, the `view === "following"` branch above is dead code reachable only by a request this plan's frontend doesn't send yet. This ordering matches how Phase 2 Task 10 and Task 12 similarly split a route's wiring from its full feature.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -w apps/web -- route-refactor.test api-wiring-p2.test prompts.test listPrompts.test`
Expected: PASS. Re-check `tests/api-wiring-p2.test.ts` (Phase 2, Task 10) specifically — it calls `GET /api/prompts` with no cookie against a single-user test DB, so it must still pass unchanged under the single-user fallback.

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/app/api/drafts/route.ts frontend/apps/web/app/api/prompts/route.ts frontend/apps/web/app/api/prompts/\[promptId\]/edit/route.ts frontend/apps/web/tests/route-refactor.test.ts
git commit -m "refactor(web): the three OWNER_USER_ID-hardcoded routes now use getCurrentUserId"
```

---

### Task 7: `access.ts` + `visibility.ts` — visibility toggle, archiving followers on unshare

**Files:**
- Create: `apps/web/src/server/access.ts`, `apps/web/src/server/visibility.ts`, `apps/web/app/api/prompts/[promptId]/visibility/route.ts`
- Test: `apps/web/tests/visibility.test.ts`

**Interfaces:**
- Produces: `ForbiddenError`; `canAccess(prompt: { owner_user_id: number; visibility: string }, userId: number): boolean`. `setVisibility(raw, { promptId, userId, visibility }): void` — only the owner may call it; going `'shared' → 'private'` archives every other user's watchlist for that prompt in the same call, never the owner's own.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/visibility.test.ts
import { describe, expect, it } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { setVisibility } from "@/server/visibility";
import { ForbiddenError } from "@/server/access";

function seedSharedPromptWithFollower(raw: ReturnType<typeof createTestDb>) {
  const ownerId = ensureOwnerUser(raw);
  const now = new Date().toISOString();
  raw.prepare("INSERT INTO users (user_id, display_name, role, status, created_at) VALUES (2, 'Follower', 'member', 'active', ?)").run(now);
  raw.prepare(`INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (1, ?, 'x', 'confirmed', ?, ?)`).run(ownerId, now, now);
  raw.prepare(
    `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, visibility, confirmed_at)
     VALUES (1, ?, 1, 'T', 'x', 'literal', '{}', 'h', 'confirmed', 1, 'h', 'k', 'shared', ?)`
  ).run(ownerId, now);
  raw.prepare("INSERT INTO watchlists (watchlist_id, user_id, prompt_id, name, created_at) VALUES (1, ?, 1, 'owner wl', ?)").run(ownerId, now);
  raw.prepare("INSERT INTO watchlists (watchlist_id, user_id, prompt_id, name, created_at) VALUES (2, 2, 1, 'follower wl', ?)").run(now);
  return { ownerId };
}

describe("setVisibility", () => {
  it("only the owner may change it", () => {
    const raw = createTestDb();
    seedSharedPromptWithFollower(raw);
    expect(() => setVisibility(raw, { promptId: 1, userId: 2, visibility: "private" })).toThrow(ForbiddenError);
  });

  it("going shared -> private archives every non-owner watchlist, leaving the owner's untouched", () => {
    const raw = createTestDb();
    const { ownerId } = seedSharedPromptWithFollower(raw);
    setVisibility(raw, { promptId: 1, userId: ownerId, visibility: "private" });

    const owner = raw.prepare("SELECT archived_at FROM watchlists WHERE watchlist_id = 1").get() as any;
    expect(owner.archived_at).toBeNull();
    const follower = raw.prepare("SELECT archived_at FROM watchlists WHERE watchlist_id = 2").get() as any;
    expect(follower.archived_at).not.toBeNull();
  });

  it("going private -> shared never archives anything", () => {
    const raw = createTestDb();
    const { ownerId } = seedSharedPromptWithFollower(raw);
    setVisibility(raw, { promptId: 1, userId: ownerId, visibility: "private" });
    setVisibility(raw, { promptId: 1, userId: ownerId, visibility: "shared" });
    const follower = raw.prepare("SELECT archived_at FROM watchlists WHERE watchlist_id = 2").get() as any;
    expect(follower.archived_at).not.toBeNull(); // stayed archived from the prior unshare — re-sharing doesn't auto-restore it
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- visibility.test`
Expected: FAIL — modules don't exist yet.

- [ ] **Step 3: Write `access.ts` and `visibility.ts`**

```ts
// apps/web/src/server/access.ts
export class ForbiddenError extends Error {}

export function canAccess(prompt: { owner_user_id: number; visibility: string }, userId: number): boolean {
  return prompt.owner_user_id === userId || prompt.visibility === "shared";
}
```

```ts
// apps/web/src/server/visibility.ts
import type Database from "better-sqlite3";
import { ForbiddenError } from "@/server/access";

export function setVisibility(
  raw: Database.Database,
  { promptId, userId, visibility }: { promptId: number; userId: number; visibility: "private" | "shared" }
): void {
  const prompt = raw.prepare("SELECT owner_user_id, visibility FROM prompts WHERE prompt_id = ?").get(promptId) as
    | { owner_user_id: number; visibility: string }
    | undefined;
  if (!prompt) throw new Error(`prompt ${promptId} not found`);
  if (prompt.owner_user_id !== userId) throw new ForbiddenError(`only the owner can change prompt ${promptId}'s visibility`);

  const now = new Date().toISOString();
  raw.transaction(() => {
    raw.prepare("UPDATE prompts SET visibility = ? WHERE prompt_id = ?").run(visibility, promptId);
    if (prompt.visibility === "shared" && visibility === "private") {
      raw.prepare("UPDATE watchlists SET archived_at = ? WHERE prompt_id = ? AND user_id != ? AND archived_at IS NULL").run(now, promptId, userId);
    }
  })();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w apps/web -- visibility.test`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the route**

```ts
// apps/web/app/api/prompts/[promptId]/visibility/route.ts
import { db } from "@/server/db/client";
import { setVisibility } from "@/server/visibility";
import { ForbiddenError } from "@/server/access";
import { getCurrentUserId, AuthRequiredError } from "@/server/auth/currentUser";

export async function PATCH(req: Request, { params }: { params: { promptId: string } }) {
  const { visibility } = await req.json();
  try {
    const userId = getCurrentUserId(db(), req);
    setVisibility(db(), { promptId: Number(params.promptId), userId, visibility });
    return Response.json({ prompt_id: Number(params.promptId), visibility });
  } catch (err) {
    if (err instanceof AuthRequiredError) return Response.json({ error: "sign in required" }, { status: 401 });
    if (err instanceof ForbiddenError) return Response.json({ error: err.message }, { status: 403 });
    return Response.json({ error: (err as Error).message }, { status: 404 });
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add frontend/apps/web/src/server/access.ts frontend/apps/web/src/server/visibility.ts frontend/apps/web/app/api/prompts/\[promptId\]/visibility frontend/apps/web/tests/visibility.test.ts
git commit -m "feat(web): visibility toggle — archives non-owner watchlists on shared->private, owner-only"
```

---

### Task 8: `follow.ts` — follow/unfollow, upsert-not-duplicate, immediate seed from the latest run

**Files:**
- Create: `apps/web/src/server/follow.ts`, `apps/web/app/api/prompts/[promptId]/follow/route.ts`
- Test: `apps/web/tests/follow.test.ts`

**Interfaces:**
- Produces: `followPrompt(raw, { promptId, userId }): { watchlistId: number }` — enforces `canAccess`; reuses an existing (possibly archived) watchlist row rather than inserting a duplicate; immediately seeds the (re)activated watchlist from the prompt's latest `run_results` so a new follower doesn't see an empty table until the next weekly run. `unfollowPrompt(raw, { promptId, userId }): void` — sets `archived_at`, never deletes.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/follow.test.ts
import { describe, expect, it } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { followPrompt, unfollowPrompt } from "@/server/follow";
import { ForbiddenError } from "@/server/access";

function seedPrompt(raw: ReturnType<typeof createTestDb>, visibility: "private" | "shared") {
  const ownerId = ensureOwnerUser(raw);
  const now = new Date().toISOString();
  raw.prepare("INSERT INTO users (user_id, display_name, role, status, created_at) VALUES (2, 'Follower', 'member', 'active', ?)").run(now);
  raw.prepare(`INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (1, ?, 'x', 'confirmed', ?, ?)`).run(ownerId, now, now);
  raw.prepare(
    `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, visibility, confirmed_at)
     VALUES (1, ?, 1, 'T', 'x', 'literal', '{}', 'h', 'confirmed', 1, 'h', 'k', ?, ?)`
  ).run(ownerId, visibility, now);
  const runInfo = raw.prepare("INSERT INTO runs (prompt_id, as_of, kind, status, finished_at) VALUES (1, '2026-10-02', 'scheduled', 'done', ?)").run(now);
  const runId = Number(runInfo.lastInsertRowid);
  raw.prepare("INSERT OR IGNORE INTO symbols (symbol, active) VALUES ('FULL1', 1)").run();
  raw.prepare("INSERT INTO run_results (run_id, symbol, membership, in_forward_record, cond_json, entry_status) VALUES (?, 'FULL1', 'full_match', 0, '{}', 'pending_selection')").run(runId);
  return { ownerId, runId };
}

describe("followPrompt", () => {
  it("refuses to follow a private prompt belonging to someone else", () => {
    const raw = createTestDb();
    seedPrompt(raw, "private");
    expect(() => followPrompt(raw, { promptId: 1, userId: 2 })).toThrow(ForbiddenError);
  });

  it("creates a watchlist seeded from the latest run immediately, for a shared prompt", () => {
    const raw = createTestDb();
    seedPrompt(raw, "shared");
    const { watchlistId } = followPrompt(raw, { promptId: 1, userId: 2 });
    const entries = raw.prepare("SELECT symbol FROM watchlist_entries WHERE watchlist_id = ?").all(watchlistId) as any[];
    expect(entries).toEqual([{ symbol: "FULL1" }]);
  });

  it("re-following after unfollowing reuses the same watchlist row instead of creating a duplicate", () => {
    const raw = createTestDb();
    seedPrompt(raw, "shared");
    const first = followPrompt(raw, { promptId: 1, userId: 2 });
    unfollowPrompt(raw, { promptId: 1, userId: 2 });
    const second = followPrompt(raw, { promptId: 1, userId: 2 });
    expect(second.watchlistId).toBe(first.watchlistId);
    const count = raw.prepare("SELECT COUNT(*) AS n FROM watchlists WHERE user_id = 2 AND prompt_id = 1").get() as any;
    expect(count.n).toBe(1);
  });
});

describe("unfollowPrompt", () => {
  it("archives, never deletes", () => {
    const raw = createTestDb();
    seedPrompt(raw, "shared");
    const { watchlistId } = followPrompt(raw, { promptId: 1, userId: 2 });
    unfollowPrompt(raw, { promptId: 1, userId: 2 });
    const row = raw.prepare("SELECT archived_at FROM watchlists WHERE watchlist_id = ?").get(watchlistId) as any;
    expect(row.archived_at).not.toBeNull();
    const stillThere = raw.prepare("SELECT COUNT(*) AS n FROM watchlists WHERE watchlist_id = ?").get(watchlistId) as any;
    expect(stillThere.n).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- follow.test`
Expected: FAIL — `Cannot find module '@/server/follow'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/server/follow.ts
import type Database from "better-sqlite3";
import { ForbiddenError, canAccess } from "@/server/access";

function seedFromLatestRun(raw: Database.Database, promptId: number, watchlistId: number): void {
  const latestRun = raw.prepare("SELECT run_id FROM runs WHERE prompt_id = ? ORDER BY run_id DESC LIMIT 1").get(promptId) as { run_id: number } | undefined;
  if (!latestRun) return;

  const results = raw.prepare("SELECT symbol, membership, entry_status FROM run_results WHERE run_id = ?").all(latestRun.run_id) as
    { symbol: string; membership: string; entry_status: string | null }[];
  const now = new Date().toISOString();
  const insertEntry = raw.prepare(
    `INSERT OR IGNORE INTO watchlist_entries (watchlist_id, symbol, first_run_id, last_run_id, membership, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const r of results) {
    const status = r.entry_status ?? (r.membership === "full_match" ? "pending_selection" : "watching");
    insertEntry.run(watchlistId, r.symbol, latestRun.run_id, latestRun.run_id, r.membership, status, now, now);
  }
}

export function followPrompt(raw: Database.Database, { promptId, userId }: { promptId: number; userId: number }): { watchlistId: number } {
  const prompt = raw.prepare("SELECT owner_user_id, visibility, title FROM prompts WHERE prompt_id = ?").get(promptId) as
    | { owner_user_id: number; visibility: string; title: string }
    | undefined;
  if (!prompt) throw new Error(`prompt ${promptId} not found`);
  if (!canAccess(prompt, userId)) throw new ForbiddenError(`prompt ${promptId} is private`);

  const now = new Date().toISOString();
  const existing = raw.prepare("SELECT watchlist_id FROM watchlists WHERE user_id = ? AND prompt_id = ?").get(userId, promptId) as { watchlist_id: number } | undefined;

  const watchlistId = existing
    ? (raw.prepare("UPDATE watchlists SET archived_at = NULL WHERE watchlist_id = ?").run(existing.watchlist_id), existing.watchlist_id)
    : Number(raw.prepare("INSERT INTO watchlists (user_id, prompt_id, name, created_at) VALUES (?, ?, ?, ?)").run(userId, promptId, prompt.title, now).lastInsertRowid);

  seedFromLatestRun(raw, promptId, watchlistId);
  return { watchlistId };
}

export function unfollowPrompt(raw: Database.Database, { promptId, userId }: { promptId: number; userId: number }): void {
  const row = raw.prepare("SELECT watchlist_id FROM watchlists WHERE user_id = ? AND prompt_id = ?").get(userId, promptId) as { watchlist_id: number } | undefined;
  if (!row) throw new Error(`no watchlist for user ${userId} on prompt ${promptId}`);
  raw.prepare("UPDATE watchlists SET archived_at = ? WHERE watchlist_id = ?").run(new Date().toISOString(), row.watchlist_id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w apps/web -- follow.test`
Expected: PASS (4 tests)

- [ ] **Step 5: Write the route**

```ts
// apps/web/app/api/prompts/[promptId]/follow/route.ts
import { db } from "@/server/db/client";
import { followPrompt, unfollowPrompt } from "@/server/follow";
import { ForbiddenError } from "@/server/access";
import { getCurrentUserId, AuthRequiredError } from "@/server/auth/currentUser";

function errorResponse(err: unknown) {
  if (err instanceof AuthRequiredError) return Response.json({ error: "sign in required" }, { status: 401 });
  if (err instanceof ForbiddenError) return Response.json({ error: err.message }, { status: 403 });
  return Response.json({ error: (err as Error).message }, { status: 404 });
}

export async function POST(req: Request, { params }: { params: { promptId: string } }) {
  try {
    const userId = getCurrentUserId(db(), req);
    const { watchlistId } = followPrompt(db(), { promptId: Number(params.promptId), userId });
    return Response.json({ watchlist_id: watchlistId }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(req: Request, { params }: { params: { promptId: string } }) {
  try {
    const userId = getCurrentUserId(db(), req);
    unfollowPrompt(db(), { promptId: Number(params.promptId), userId });
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add frontend/apps/web/src/server/follow.ts frontend/apps/web/app/api/prompts/\[promptId\]/follow frontend/apps/web/tests/follow.test.ts
git commit -m "feat(web): followPrompt/unfollowPrompt — upsert-not-duplicate, seeded immediately from the latest run, never destructive"
```

---

### Task 9: `copyPrompt.ts` — Copy to my drafts

**Files:**
- Create: `apps/web/src/server/copyPrompt.ts`, `apps/web/app/api/prompts/[promptId]/copy/route.ts`
- Test: `apps/web/tests/copyPrompt.test.ts`

**Interfaces:**
- Produces: `copyPromptToDraft(raw, { promptId, userId }): { draftId: number }` — enforces `canAccess`; creates a new, independent `prompt_drafts` row owned by `userId`, pre-filled with the source prompt's text/structure/spec/hypothesis/kill-criterion, and `copied_from_prompt_id = promptId` (Task 1's new column) — **never** `parent_prompt_id`, which stays reserved for the owner's own version chain (Global Constraints).

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/copyPrompt.test.ts
import { describe, expect, it } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { copyPromptToDraft } from "@/server/copyPrompt";
import { getDraft } from "@/server/drafts";
import { ForbiddenError } from "@/server/access";

function seedSharedPrompt(raw: ReturnType<typeof createTestDb>) {
  const ownerId = ensureOwnerUser(raw);
  const now = new Date().toISOString();
  raw.prepare("INSERT INTO users (user_id, display_name, role, status, created_at) VALUES (2, 'Copier', 'member', 'active', ?)").run(now);
  raw.prepare(`INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (1, ?, 'the original prompt text', 'confirmed', ?, ?)`).run(ownerId, now, now);
  raw.prepare(
    `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, visibility, confirmed_at)
     VALUES (15, ?, 1, 'Original', 'the original prompt text', 'literal', '{"spec_version":4}', 'h', 'confirmed', 1, 'hyp', 'kill', 'shared', ?)`
  ).run(ownerId, now);
  return { ownerId };
}

describe("copyPromptToDraft", () => {
  it("creates a new draft owned by the copier, pre-filled from the source prompt, recorded as copied_from_prompt_id", () => {
    const raw = createTestDb();
    seedSharedPrompt(raw);
    const { draftId } = copyPromptToDraft(raw, { promptId: 15, userId: 2 });
    const draft = getDraft(raw, draftId)!;
    expect(draft.userId).toBe(2);
    expect(draft.promptText).toBe("the original prompt text");
    expect(draft.structure).toBe("literal");
    expect(draft.hypothesis).toBe("hyp");
    expect(draft.copiedFromPromptId).toBe(15);
  });

  it("refuses to copy a private prompt belonging to someone else", () => {
    const raw = createTestDb();
    const ownerId = ensureOwnerUser(raw);
    const now = new Date().toISOString();
    raw.prepare("INSERT INTO users (user_id, display_name, role, status, created_at) VALUES (2, 'Copier', 'member', 'active', ?)").run(now);
    raw.prepare(`INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (1, ?, 'x', 'confirmed', ?, ?)`).run(ownerId, now, now);
    raw.prepare(
      `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, visibility, confirmed_at)
       VALUES (15, ?, 1, 'T', 'x', 'literal', '{}', 'h', 'confirmed', 1, 'h', 'k', 'private', ?)`
    ).run(ownerId, now);
    expect(() => copyPromptToDraft(raw, { promptId: 15, userId: 2 })).toThrow(ForbiddenError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- copyPrompt.test`
Expected: FAIL — `Cannot find module '@/server/copyPrompt'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/server/copyPrompt.ts
import type Database from "better-sqlite3";
import { ForbiddenError, canAccess } from "@/server/access";

export function copyPromptToDraft(raw: Database.Database, { promptId, userId }: { promptId: number; userId: number }): { draftId: number } {
  const prompt = raw.prepare("SELECT * FROM prompts WHERE prompt_id = ?").get(promptId) as any;
  if (!prompt) throw new Error(`prompt ${promptId} not found`);
  if (!canAccess(prompt, userId)) throw new ForbiddenError(`prompt ${promptId} is private`);

  const now = new Date().toISOString();
  const info = raw
    .prepare(
      `INSERT INTO prompt_drafts
         (user_id, copied_from_prompt_id, title, prompt_text, structure, spec_json, hypothesis, kill_criterion, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
    )
    .run(userId, promptId, prompt.title, prompt.prompt_text, prompt.structure, prompt.spec_json, prompt.hypothesis, prompt.kill_criterion, now, now);
  return { draftId: Number(info.lastInsertRowid) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w apps/web -- copyPrompt.test`
Expected: PASS (2 tests)

- [ ] **Step 5: Write the route**

```ts
// apps/web/app/api/prompts/[promptId]/copy/route.ts
import { db } from "@/server/db/client";
import { copyPromptToDraft } from "@/server/copyPrompt";
import { ForbiddenError } from "@/server/access";
import { getCurrentUserId, AuthRequiredError } from "@/server/auth/currentUser";

export async function POST(req: Request, { params }: { params: { promptId: string } }) {
  try {
    const userId = getCurrentUserId(db(), req);
    const { draftId } = copyPromptToDraft(db(), { promptId: Number(params.promptId), userId });
    return Response.json({ draft_id: draftId }, { status: 201 });
  } catch (err) {
    if (err instanceof AuthRequiredError) return Response.json({ error: "sign in required" }, { status: 401 });
    if (err instanceof ForbiddenError) return Response.json({ error: err.message }, { status: 403 });
    return Response.json({ error: (err as Error).message }, { status: 404 });
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add frontend/apps/web/src/server/copyPrompt.ts frontend/apps/web/app/api/prompts/\[promptId\]/copy frontend/apps/web/tests/copyPrompt.test.ts
git commit -m "feat(web): copyPromptToDraft — Copy to my drafts, lineage via copied_from_prompt_id, never parent_prompt_id"
```

---

### Task 10: `explore.ts` + `GET /api/explore` + `listPrompts`'s `view: "following"`

**Files:**
- Create: `apps/web/src/server/explore.ts`, `apps/web/app/api/explore/route.ts`
- Modify: `apps/web/src/server/listPrompts.ts`
- Test: `apps/web/tests/explore.test.ts`, extend `apps/web/tests/listPrompts.test.ts`

**Interfaces:**
- Produces: `listExplore(raw, { userId, structure?, usesCondition?, sort? }): ExploreRow[]` — every `visibility = 'shared'` confirmed prompt, each `{promptId, title, structure, ownerName, isMine, followers, gradedWeeks}`, filterable by `structure`/`usesCondition` (a `prompt_conditions.name`), sortable by `"followers"`/`"graded_weeks"`/default newest-`promptId`. `listPrompts(raw, { userId, view: "following" })` — one row per prompt the user follows but doesn't own (`watchlists` join `prompts` where `owner_user_id != userId`), `{promptId, title, ownerName, gradedWeeks, lastHorizon1Return}`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/tests/explore.test.ts
import { describe, expect, it } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { listExplore } from "@/server/explore";

function seedTwoSharedAndOnePrivate(raw: ReturnType<typeof createTestDb>) {
  const ownerId = ensureOwnerUser(raw);
  const now = new Date().toISOString();
  raw.prepare("INSERT INTO users (user_id, display_name, role, status, created_at) VALUES (2, 'Other', 'member', 'active', ?)").run(now);
  const rows: [number, string, string][] = [[10, "shared", "literal"], [11, "shared", "t1_literal"], [12, "private", "literal"]];
  rows.forEach(([promptId, visibility, structure], i) => {
    raw.prepare(`INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (?, ?, 'x', 'confirmed', ?, ?)`).run(promptId, i === 0 ? ownerId : 2, now, now);
    raw.prepare(
      `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, visibility, confirmed_at)
       VALUES (?, ?, ?, ?, 'x', ?, '{}', ?, 'confirmed', 1, 'h', 'k', ?, ?)`
    ).run(promptId, i === 0 ? ownerId : 2, promptId, `Prompt ${promptId}`, structure, `hash${promptId}`, visibility, now);
  });
  raw.prepare("INSERT INTO watchlists (user_id, prompt_id, name, created_at) VALUES (2, 10, 'f', ?)").run(now);
  return { ownerId };
}

describe("listExplore", () => {
  it("returns only shared prompts, with isMine and followers correct", () => {
    const raw = createTestDb();
    const { ownerId } = seedTwoSharedAndOnePrivate(raw);
    const rows = listExplore(raw, { userId: ownerId });
    expect(rows.map((r) => r.promptId).sort()).toEqual([10, 11]);
    const mine = rows.find((r) => r.promptId === 10)!;
    expect(mine.isMine).toBe(true);
    expect(mine.followers).toBe(1);
  });

  it("filters by structure", () => {
    const raw = createTestDb();
    const { ownerId } = seedTwoSharedAndOnePrivate(raw);
    const rows = listExplore(raw, { userId: ownerId, structure: "t1_literal" });
    expect(rows.map((r) => r.promptId)).toEqual([11]);
  });

  it("sorts by followers descending when sort='followers'", () => {
    const raw = createTestDb();
    const { ownerId } = seedTwoSharedAndOnePrivate(raw);
    const rows = listExplore(raw, { userId: ownerId, sort: "followers" });
    expect(rows[0].promptId).toBe(10);
  });
});
```

```ts
// apps/web/tests/listPrompts.test.ts — append
describe("listPrompts — view following", () => {
  it("returns prompts the user follows but doesn't own", () => {
    const raw = createTestDb();
    const userId = ensureOwnerUser(raw);
    const now = new Date().toISOString();
    raw.prepare("INSERT INTO users (user_id, display_name, role, status, created_at) VALUES (2, 'Owner2', 'member', 'active', ?)").run(now);
    raw.prepare(`INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (1, 2, 'x', 'confirmed', ?, ?)`).run(now, now);
    raw.prepare(
      `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, visibility, confirmed_at)
       VALUES (20, 2, 1, 'Theirs', 'x', 'literal', '{}', 'h', 'confirmed', 1, 'h', 'k', 'shared', ?)`
    ).run(now);
    raw.prepare("INSERT INTO watchlists (user_id, prompt_id, name, created_at) VALUES (?, 20, 'following', ?)").run(userId, now);

    const rows = listPrompts(raw, { userId, view: "following" }) as any[];
    expect(rows).toEqual([expect.objectContaining({ promptId: 20, ownerName: "Owner2" })]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -w apps/web -- explore.test listPrompts.test`
Expected: FAIL — `listExplore` doesn't exist, `view: "following"` isn't handled yet.

- [ ] **Step 3: Write `explore.ts`**

```ts
// apps/web/src/server/explore.ts
import type Database from "better-sqlite3";

export function listExplore(
  raw: Database.Database,
  { userId, structure, usesCondition, sort }: { userId: number; structure?: string; usesCondition?: string; sort?: "followers" | "graded_weeks" }
) {
  let sql = `SELECT p.prompt_id, p.title, p.structure, p.owner_user_id, u.display_name AS owner_name
             FROM prompts p JOIN users u ON u.user_id = p.owner_user_id
             WHERE p.visibility = 'shared' AND p.status = 'confirmed'`;
  const params: unknown[] = [];
  if (structure) { sql += " AND p.structure = ?"; params.push(structure); }
  if (usesCondition) {
    sql += " AND EXISTS (SELECT 1 FROM prompt_conditions pc WHERE pc.prompt_id = p.prompt_id AND pc.name = ?)";
    params.push(usesCondition);
  }
  const rows = raw.prepare(sql).all(...params) as any[];

  const selectFollowers = raw.prepare("SELECT COUNT(*) AS n FROM watchlists WHERE prompt_id = ? AND user_id != ? AND archived_at IS NULL");
  const selectGradedWeeks = raw.prepare("SELECT COUNT(*) AS n FROM runs WHERE prompt_id = ? AND kind IN ('scheduled','catch_up')");

  const mapped = rows.map((p) => ({
    promptId: p.prompt_id, title: p.title, structure: p.structure, ownerName: p.owner_name,
    isMine: p.owner_user_id === userId,
    followers: (selectFollowers.get(p.prompt_id, p.owner_user_id) as { n: number }).n,
    gradedWeeks: (selectGradedWeeks.get(p.prompt_id) as { n: number }).n,
  }));

  if (sort === "followers") mapped.sort((a, b) => b.followers - a.followers);
  else if (sort === "graded_weeks") mapped.sort((a, b) => b.gradedWeeks - a.gradedWeeks);
  else mapped.sort((a, b) => b.promptId - a.promptId);

  return mapped;
}
```

- [ ] **Step 4: Extend `listPrompts.ts`**

```ts
// apps/web/src/server/listPrompts.ts
export function listPrompts(raw: Database.Database, { userId, view }: { userId: number; view: "mine" | "drafts" | "following" }) {
  if (view === "drafts") {
    // ...unchanged from Phase 2...
  }

  if (view === "following") {
    const rows = raw
      .prepare(
        `SELECT p.prompt_id, p.title, u.display_name AS owner_name
         FROM watchlists w JOIN prompts p ON p.prompt_id = w.prompt_id JOIN users u ON u.user_id = p.owner_user_id
         WHERE w.user_id = ? AND p.owner_user_id != ? AND w.archived_at IS NULL
         ORDER BY p.prompt_id DESC`
      )
      .all(userId, userId) as any[];
    const selectGradedWeeks = raw.prepare("SELECT COUNT(*) AS n FROM runs WHERE prompt_id = ? AND kind IN ('scheduled','catch_up')");
    const selectLastRun = raw.prepare("SELECT run_id FROM runs WHERE prompt_id = ? ORDER BY run_id DESC LIMIT 1");
    const selectHorizon1 = raw.prepare("SELECT ew_return FROM validations WHERE run_id = ? AND horizon_w = 1");
    return rows.map((p) => {
      const lastRun = selectLastRun.get(p.prompt_id) as { run_id: number } | undefined;
      const validation = lastRun ? (selectHorizon1.get(lastRun.run_id) as { ew_return: number } | undefined) : undefined;
      return {
        promptId: p.prompt_id, title: p.title, ownerName: p.owner_name,
        gradedWeeks: (selectGradedWeeks.get(p.prompt_id) as { n: number }).n,
        lastHorizon1Return: validation ? validation.ew_return : null,
      };
    });
  }

  // ...unchanged "mine" branch from Phase 2...
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test -w apps/web -- explore.test listPrompts.test`
Expected: PASS (6 tests across both files' new cases, all Phase 2 cases still passing)

- [ ] **Step 6: Write the route**

```ts
// apps/web/app/api/explore/route.ts
import { db } from "@/server/db/client";
import { listExplore } from "@/server/explore";
import { getCurrentUserId, AuthRequiredError } from "@/server/auth/currentUser";

export async function GET(req: Request) {
  try {
    const userId = getCurrentUserId(db(), req);
    const url = new URL(req.url);
    const structure = url.searchParams.get("structure") ?? undefined;
    const usesCondition = url.searchParams.get("uses_condition") ?? undefined;
    const sort = (url.searchParams.get("sort") as "followers" | "graded_weeks" | null) ?? undefined;
    return Response.json(listExplore(db(), { userId, structure, usesCondition, sort }));
  } catch (err) {
    if (err instanceof AuthRequiredError) return Response.json({ error: "sign in required" }, { status: 401 });
    throw err;
  }
}
```

- [ ] **Step 7: Commit**

```bash
git add frontend/apps/web/src/server/explore.ts frontend/apps/web/src/server/listPrompts.ts frontend/apps/web/app/api/explore frontend/apps/web/tests/explore.test.ts frontend/apps/web/tests/listPrompts.test.ts
git commit -m "feat(web): listExplore + listPrompts view=following + GET /api/explore"
```

---

### Task 11: Frontend — login/signup pages + `AuthGate`

**Files:**
- Create: `apps/web/app/login/page.tsx`, `apps/web/app/signup/page.tsx`, `apps/web/src/components/AuthGate.tsx`
- Modify: `apps/web/app/layout.tsx` (wraps children in `AuthGate`)
- Test: `apps/web/tests/components/AuthGate.test.tsx`

**Interfaces:**
- Produces: `AuthGate({ children })` — calls `GET /api/auth/me` once on mount; while `multiUser` is `false`, renders `children` unconditionally (frontend plan §2 — no login screen in single-user mode, exactly Phases 1–3's behavior); once `multiUser` is `true` and `currentUser` is `null`, renders a "Sign in" link to `/login` instead of `children`; otherwise renders `children`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/tests/components/AuthGate.test.tsx
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AuthGate } from "@/components/AuthGate";

afterEach(() => { vi.restoreAllMocks(); });

describe("AuthGate", () => {
  it("renders children immediately in single-user mode, without waiting on a sign-in", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ json: async () => ({ multiUser: false, currentUser: { userId: 1, displayName: "Owner", email: null } }) } as any);
    render(<AuthGate><p>app content</p></AuthGate>);
    await waitFor(() => expect(screen.getByText("app content")).toBeInTheDocument());
  });

  it("shows a sign-in prompt instead of children once multiUser is true and nobody is signed in", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ json: async () => ({ multiUser: true, currentUser: null }) } as any);
    render(<AuthGate><p>app content</p></AuthGate>);
    await waitFor(() => expect(screen.getByText(/sign in/i)).toBeInTheDocument());
    expect(screen.queryByText("app content")).not.toBeInTheDocument();
  });

  it("renders children once multiUser is true and someone is signed in", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ json: async () => ({ multiUser: true, currentUser: { userId: 2, displayName: "Second", email: "s@example.com" } }) } as any);
    render(<AuthGate><p>app content</p></AuthGate>);
    await waitFor(() => expect(screen.getByText("app content")).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- AuthGate`
Expected: FAIL — `Cannot find module '@/components/AuthGate'`

- [ ] **Step 3: Write `AuthGate.tsx`**

```tsx
// apps/web/src/components/AuthGate.tsx
"use client";
import { useEffect, useState } from "react";

type Me = { multiUser: boolean; currentUser: { userId: number; displayName: string; email: string | null } | null };

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    fetch("/api/auth/me").then((r) => r.json()).then(setMe);
  }, []);

  if (!me) return null;
  if (me.multiUser && !me.currentUser) {
    return (
      <main>
        <p>
          <a href="/login">Sign in</a> to continue.
        </p>
      </main>
    );
  }
  return <>{children}</>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w apps/web -- AuthGate`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the login/signup pages and wrap `layout.tsx`**

```tsx
// apps/web/app/login/page.tsx
"use client";
import { useState } from "react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const res = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    if (!res.ok) { setError("invalid email or password"); return; }
    window.location.href = "/";
  }

  return (
    <main>
      <h1>Sign in</h1>
      <label>Email <input aria-label="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <label>Password <input aria-label="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      <button type="button" onClick={submit}>Sign in</button>
      {error && <p role="alert">{error}</p>}
      <p><a href="/signup">Create an account</a></p>
    </main>
  );
}
```

```tsx
// apps/web/app/signup/page.tsx
"use client";
import { useState } from "react";

export default function SignupPage() {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const res = await fetch("/api/auth/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName, email, password }) });
    const body = await res.json();
    if (!res.ok) { setError(body.error ?? "could not create account"); return; }
    window.location.href = "/";
  }

  return (
    <main>
      <h1>Create an account</h1>
      <label>Name <input aria-label="display name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></label>
      <label>Email <input aria-label="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <label>Password <input aria-label="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      <button type="button" onClick={submit}>Create account</button>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
```

```tsx
// apps/web/app/layout.tsx
import { AuthGate } from "@/components/AuthGate";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body><AuthGate>{children}</AuthGate></body>
    </html>
  );
}
```

- [ ] **Step 6: Build check**

Run: `npm run build -w apps/web`
Expected: builds with no type errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/apps/web/app/login frontend/apps/web/app/signup frontend/apps/web/app/layout.tsx frontend/apps/web/src/components/AuthGate.tsx frontend/apps/web/tests/components/AuthGate.test.tsx
git commit -m "feat(web): login/signup pages + AuthGate — invisible in single-user mode, as specified"
```

---

### Task 12: Frontend — Explore page

**Files:**
- Create: `apps/web/app/explore/page.tsx`
- Modify: `apps/web/app/prompts/page.tsx` (enable the "Following" tab, wire it to real data; add a Share/Unshare toggle to the Mine table)

**Interfaces:**
- `app/explore/page.tsx` fetches `GET /api/explore` with structure/sort query params from simple select controls, renders a grid of cards (Prompt #, structure, owner, title, graded weeks, followers), each with a Follow/Following toggle (`POST`/`DELETE /api/prompts/:id/follow`) and a "Copy to my drafts" button (`POST /api/prompts/:id/copy` → navigates to `/drafts/:draft_id`). `app/prompts/page.tsx`'s Mine table gains a Share/Unshare button calling `PATCH /api/prompts/:id/visibility`; its Following tab (disabled in Phase 2) now fetches `GET /api/prompts?view=following` and renders the same table shape with the owner's display name.

- [ ] **Step 1: Write `app/explore/page.tsx`**

```tsx
// apps/web/app/explore/page.tsx
"use client";
import { useEffect, useState } from "react";

export default function ExplorePage() {
  const [rows, setRows] = useState<any[] | null>(null);
  const [structure, setStructure] = useState("");
  const [sort, setSort] = useState("");
  const [following, setFollowing] = useState<Set<number>>(new Set());

  async function load() {
    const params = new URLSearchParams();
    if (structure) params.set("structure", structure);
    if (sort) params.set("sort", sort);
    const res = await fetch(`/api/explore?${params.toString()}`);
    setRows(await res.json());
  }

  useEffect(() => { load(); }, [structure, sort]);

  async function toggleFollow(promptId: number, isFollowing: boolean) {
    await fetch(`/api/prompts/${promptId}/follow`, { method: isFollowing ? "DELETE" : "POST" });
    setFollowing((prev) => {
      const next = new Set(prev);
      if (isFollowing) next.delete(promptId); else next.add(promptId);
      return next;
    });
  }

  async function copyToDrafts(promptId: number) {
    const res = await fetch(`/api/prompts/${promptId}/copy`, { method: "POST" });
    if (res.ok) {
      const { draft_id } = await res.json();
      window.location.href = `/drafts/${draft_id}`;
    }
  }

  return (
    <main>
      <h1>Explore</h1>
      <label>
        Structure
        <select aria-label="filter by structure" value={structure} onChange={(e) => setStructure(e.target.value)}>
          <option value="">any</option>
          <option value="literal">literal</option>
          <option value="t1_literal">t1_literal</option>
        </select>
      </label>
      <label>
        Sort
        <select aria-label="sort" value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="">newest Prompt ID</option>
          <option value="graded_weeks">most graded weeks</option>
          <option value="followers">most followers</option>
        </select>
      </label>

      <div>
        {(rows ?? []).map((r) => (
          <article key={r.promptId}>
            <h2>Prompt {r.promptId}{r.isMine && " · Yours"}</h2>
            <p>{r.title} — {r.structure} — by {r.ownerName}</p>
            <p>Graded week {r.gradedWeeks} of 13 · {r.followers} follower{r.followers === 1 ? "" : "s"}</p>
            {!r.isMine && (
              <>
                <button type="button" onClick={() => toggleFollow(r.promptId, following.has(r.promptId))}>
                  {following.has(r.promptId) ? "Following ✓" : "Follow"}
                </button>{" "}
                <button type="button" onClick={() => copyToDrafts(r.promptId)}>Copy to my drafts</button>
              </>
            )}
          </article>
        ))}
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Extend `app/prompts/page.tsx`**

```tsx
// apps/web/app/prompts/page.tsx — modify
  const [following, setFollowing] = useState<any[] | null>(null);

  useEffect(() => {
    fetch("/api/prompts?view=mine").then((r) => r.json()).then(setMine);
    fetch("/api/prompts?view=drafts").then((r) => r.json()).then(setDrafts);
    fetch("/api/prompts?view=following").then((r) => r.json()).then(setFollowing);
  }, []);

  async function toggleShare(promptId: number, currentlyShared: boolean) {
    const res = await fetch(`/api/prompts/${promptId}/visibility`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ visibility: currentlyShared ? "private" : "shared" }),
    });
    if (res.ok) setMine((rows) => rows!.map((r) => (r.promptId === promptId ? { ...r, visibility: currentlyShared ? "private" : "shared" } : r)));
  }

// Replace the disabled "Following" button with:
        <button type="button" onClick={() => setTab("following")} aria-pressed={tab === "following"}>Following</button>

// Add a Share toggle next to the existing Edit/Retire buttons in the Mine row's Actions cell:
                  {p.status === "confirmed" && (
                    <>
                      <button type="button" onClick={() => editAsNewVersion(p.promptId)}>Edit as new version</button>{" "}
                      <button type="button" onClick={() => retire(p.promptId)}>Retire</button>{" "}
                      <button type="button" onClick={() => toggleShare(p.promptId, p.visibility === "shared")}>
                        {p.visibility === "shared" ? "Unshare" : "Share"}
                      </button>
                    </>
                  )}

// Add the Following tab's table, alongside the existing "mine"/"drafts" blocks:
      {tab === "following" && (
        <table>
          <thead><tr><th>Prompt</th><th>Owner</th><th>Graded</th><th>1-week return</th></tr></thead>
          <tbody>
            {(following ?? []).map((p) => (
              <tr key={p.promptId}>
                <td><a href={`/watchlists/${p.promptId}`}>Prompt {p.promptId}</a> — {p.title}</td>
                <td>{p.ownerName}</td>
                <td>week {p.gradedWeeks} of 13</td>
                <td>{p.lastHorizon1Return === null ? "not graded yet" : `${p.lastHorizon1Return.toFixed(2)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
```

- [ ] **Step 3: Build check and manual smoke test**

Run: `npm run build -w apps/web`
Expected: builds with no type errors.

Then, manually (needs two real users — sign up a second one via `/signup`, share a prompt from the first, log in as the second, visit `/explore`, follow it, confirm it shows up under `/prompts`'s Following tab): this is the one check that can't be hermetic, same category as every Phase's own manual smoke test.

- [ ] **Step 4: Commit**

```bash
git add frontend/apps/web/app/explore frontend/apps/web/app/prompts/page.tsx
git commit -m "feat(web): Explore page + My-prompts Following tab + Share/Unshare toggle"
```

---

### Task 13: Access-rule regression tests

**Files:**
- Create: `apps/web/tests/access-rules.test.ts`

**Interfaces:**
- Consumes: `followPrompt`/`unfollowPrompt` (Task 8), `copyPromptToDraft` (Task 9), `setVisibility` (Task 7), `listExplore` (Task 10) — a consolidated regression pass over the five Review Focus items, run together so a future change to any one service can't silently break what another test file already covers in isolation.

- [ ] **Step 1: Write the regression tests**

```ts
// apps/web/tests/access-rules.test.ts
import { describe, expect, it } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { followPrompt, unfollowPrompt } from "@/server/follow";
import { copyPromptToDraft } from "@/server/copyPrompt";
import { setVisibility } from "@/server/visibility";
import { listExplore } from "@/server/explore";
import { ForbiddenError } from "@/server/access";

function seedPrompt(raw: ReturnType<typeof createTestDb>, visibility: "private" | "shared") {
  const ownerId = ensureOwnerUser(raw);
  const now = new Date().toISOString();
  raw.prepare("INSERT INTO users (user_id, display_name, role, status, created_at) VALUES (2, 'Other', 'member', 'active', ?)").run(now);
  raw.prepare(`INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (1, ?, 'x', 'confirmed', ?, ?)`).run(ownerId, now, now);
  raw.prepare(
    `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, visibility, confirmed_at)
     VALUES (1, ?, 1, 'T', 'x', 'literal', '{}', 'h', 'confirmed', 1, 'h', 'k', ?, ?)`
  ).run(ownerId, visibility, now);
  return { ownerId };
}

describe("access rules — private prompts are invisible and untouchable to non-owners", () => {
  it("a private prompt never appears in Explore, even to its own owner's view of other prompts", () => {
    const raw = createTestDb();
    const { ownerId } = seedPrompt(raw, "private");
    expect(listExplore(raw, { userId: ownerId })).toEqual([]);
    expect(listExplore(raw, { userId: 2 })).toEqual([]);
  });

  it("follow, copy are both rejected for a private prompt owned by someone else", () => {
    const raw = createTestDb();
    seedPrompt(raw, "private");
    expect(() => followPrompt(raw, { promptId: 1, userId: 2 })).toThrow(ForbiddenError);
    expect(() => copyPromptToDraft(raw, { promptId: 1, userId: 2 })).toThrow(ForbiddenError);
  });

  it("the owner can always follow or copy their own prompt regardless of visibility", () => {
    const raw = createTestDb();
    const { ownerId } = seedPrompt(raw, "private");
    expect(() => followPrompt(raw, { promptId: 1, userId: ownerId })).not.toThrow();
    expect(() => copyPromptToDraft(raw, { promptId: 1, userId: ownerId })).not.toThrow();
  });
});

describe("access rules — unsharing is non-destructive and owner-scoped", () => {
  it("unsharing archives followers but the prompt and every record survive", () => {
    const raw = createTestDb();
    const { ownerId } = seedPrompt(raw, "shared");
    followPrompt(raw, { promptId: 1, userId: 2 });
    setVisibility(raw, { promptId: 1, userId: ownerId, visibility: "private" });

    const prompt = raw.prepare("SELECT status FROM prompts WHERE prompt_id = 1").get() as any;
    expect(prompt.status).toBe("confirmed");
    const follower = raw.prepare("SELECT archived_at FROM watchlists WHERE user_id = 2 AND prompt_id = 1").get() as any;
    expect(follower.archived_at).not.toBeNull();
  });

  it("a non-owner can never change visibility, even on a prompt they follow", () => {
    const raw = createTestDb();
    seedPrompt(raw, "shared");
    followPrompt(raw, { promptId: 1, userId: 2 });
    expect(() => setVisibility(raw, { promptId: 1, userId: 2, visibility: "private" })).toThrow(ForbiddenError);
  });
});

describe("access rules — unfollow/re-follow never duplicates or deletes", () => {
  it("unfollow then re-follow ends with exactly one watchlist row, active again", () => {
    const raw = createTestDb();
    seedPrompt(raw, "shared");
    const first = followPrompt(raw, { promptId: 1, userId: 2 });
    unfollowPrompt(raw, { promptId: 1, userId: 2 });
    const second = followPrompt(raw, { promptId: 1, userId: 2 });
    expect(second.watchlistId).toBe(first.watchlistId);
    const rows = raw.prepare("SELECT archived_at FROM watchlists WHERE user_id = 2 AND prompt_id = 1").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].archived_at).toBeNull();
  });
});
```

- [ ] **Step 2: Run the regression suite**

Run: `npm run test -w apps/web -- access-rules.test`
Expected: PASS (7 tests)

- [ ] **Step 3: Commit**

```bash
git add frontend/apps/web/tests/access-rules.test.ts
git commit -m "test(web): consolidated access-rule regression suite — private prompts, non-destructive unshare/unfollow"
```

---

## What Phase 4 deliberately leaves out

- **Password reset / email verification / "forgot password"** — out of scope for a local research tool with at most a handful of users; `users.email` is unique but nothing sends mail.
- **Role-based permissions beyond owner-vs-everyone-else** — `users.role` (`'owner'|'member'`, already in the Phase 1 schema) isn't read by any access check in this plan; every rule here is purely `owner_user_id === userId` vs. `visibility`.
- **Explore's "uses condition" filter as a proper autocomplete** — `listExplore`'s `usesCondition` parameter works (Task 10), but the Explore page (Task 12) doesn't yet expose a control for it; wiring a condition-name picker is cosmetic and left for a follow-up once Explore has real shared prompts to filter.
- **A live two-browser manual walkthrough of the whole sharing loop** — Task 12's Step 3 names the manual check; it needs two real signed-up users and is this phase's equivalent of every other phase's own un-automatable smoke test.

## Execution Handoff

All three plans are now saved:
- `docs/superpowers/plans/2026-10-06-prompt-screener-frontend-p2.md` (grading, versioning, My Prompts)
- `docs/superpowers/plans/2026-10-06-prompt-screener-frontend-p3.md` (prompt compiler)
- `docs/superpowers/plans/2026-10-06-prompt-screener-frontend-p4.md` (this plan — sharing + multi-user login)

They're meant to run in this order — P3's confirm-gate changes build on P2's confirm.ts refactor, and P4's route refactor touches routes P2 created — so please review all three before picking an execution approach. Which would you prefer?

- **Subagent-driven** — a fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end of each plan (or of all three together, your call). Most thorough; costs a fresh context per task and per review, and there are 12 + 12 + 13 = 37 tasks across the three plans.
- **Native** — I implement every task myself in this session, in order (P2 → P3 → P4), then one fresh reviewer checks the whole branch at the end. Cheapest and fastest; no independent review until the end.

Given the size (37 tasks touching the DB schema, the engine client, the compiler, and auth, several of which — Task 8 of P2's `confirm.ts` refactor, Task 9 of P3's `value_origin` logic, Task 6 of P4's route refactor — are load-bearing for everything built on top of them in the same or a later plan) I'd lean toward **subagent-driven**, with a review gate after P2 and after P3 before starting the next plan, so a mistake in an early foundation doesn't get built on silently for another dozen tasks. Native is a reasonable, cheaper alternative if you'd rather move fast and catch problems at one final review. Do the three plans capture what you want, and which approach should we use?
