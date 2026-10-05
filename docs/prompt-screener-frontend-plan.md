# Prompt Screener — frontend + UI plan (v3.2)

Status: plan + design. v3.2 is 03 Oct 2026, 19:42. It is aligned with `docs/prompt-screener-backend-plan.md` v3.2 (decisions D1–D11) and brings **N2 (sharing and following prompts) into scope**.
Design canvas: the "Prompt Screener Dashboard" artifact on claude.ai, **redrawn for v3.2** with 4 screens: Watchlist, New prompt, My prompts, Explore. All numbers on it are illustrative.

## 1. What the user can do

1. **Write a prompt** (saved as a numbered draft).
   - The app reads it into the Literal or T1-literal structure, using **only what the user wrote** (D6, D7).
   - Anything missing is asked as a plain question with no pre-filled answer. The one exception is liquidity, which offers ₹10 cr/week to confirm, change or decline (D3).
2. **Confirm** the prompt. It gets a numeric **Prompt ID** (for example "Prompt 12"), which is also its shadow Test arm id (D5, D9).
3. **Watch it.** The user gets one watchlist per (User ID, Prompt ID) (D10).
   - Arm picks: full matches, graded against Control.
   - Near misses: shown on the watchlist only, never graded (D8).
   - Prices are fetched when the watchlist opens and on Refresh (D2).
4. **Share and follow** (N2):
   - The owner can mark a prompt **Shared**.
   - Other users can **Follow** it, which gives them their own watchlist on it, or **Copy to my drafts** to make their own version under a new Prompt ID.

## 2. Stack (local)

- **Next.js** (TypeScript) at `localhost:3000`, with TanStack Query and zod schemas from `packages/spec`
- **SVG charts** (no chart library)
- **Session:** User 1 is signed in automatically. Login appears only once a second user exists, which is also when Explore becomes useful.
- **URLs use numeric ids:** `/prompts/12`, `/watchlists/7`, `/drafts/58`, `/explore`

## 3. Screens (all on the canvas)

### 3.1 Watchlist (Prompt 12)

- **Header**
  - Prompt number, structure badge, "Shadow arm · graded vs Control"
  - Owner, visibility, follower count
  - Version line ("version 2, replaces Prompt 9")
- **Actions:** "Edit as new version", "Export CSV", "Dry run now" (tooltip: not recorded in the forward test).
- **Prompt card**
  - The user's prompt text.
  - Condition chips C1…Cn, each with a dot showing where it came from: **grey = from the prompt, amber = the user's answer**.
  - Also chips for entry point, stop and near-miss depth.
  - A **"Structure steps used"** line that lists what's on (✓) and what's off (—), for example "Risk cap: not in prompt".
- **Prices bar:** "Prices as of … · Yahoo Finance · may be delayed · last trade …" and **Refresh prices**. Nothing is presented as live.
- **KPI row**
  - Arm picks (entered / awaiting Monday open / not confirmed)
  - Average since entry (entered picks only)
  - Shadow on watchlist ("not graded")
  - Next selection
- **Table**
  - **Tabs:** All · Arm picks · Near miss. The risk-cap tab only appears when the prompt sets a risk cap; otherwise a note says why it's hidden.
  - **Columns:** Stock · LTP · Today · Added (run week) · **Status** · Since entry (or "ref" for shadows) · C1–Cn flags · Entry / Stop · 12-week trend.
  - **Status chips:**
    - Entered (date)
    - Selection Mon (date)
    - Not confirmed at open
    - Watching · not graded
    - Reference price (date)
  - **Condition flag columns come from the prompt's own conditions** (count and labels vary per prompt). Columns that don't apply are hidden.
- **Detail panel**
  - Status chip.
  - A **watchlist-only banner** for shadows.
  - Price with the prompt's own indicators drawn using **its** parameters (for example VStop(10, 2)).
  - "Your conditions", each with its actual value.
  - Four level tiles that change by status: entered, pending, not confirmed, or shadow.
  - A personal note (only you see it).
  - "Remove from my watchlist" (affects only this user).
- **Validation card:** **arm picks vs Control only**, with graded week N of 13 and the 1-, 2- and 3-week returns. It states that near misses are not graded.

### 3.2 New prompt (draft)

- **Draft label:** "Draft 58 · not yet numbered", with autosave.
- **Prompt box and "Read my prompt"**, with a summary line ("5 conditions found · 4 questions").
- **Structure:** Literal or T1-literal radio cards, showing which words decided it.
- **"What will run":** a ✓ / — list of structure steps that updates as answers come in.
- **"How your prompt was read":** Role · Condition · Parameters · Your words. Missing parameters show as an amber "?". There is no defaults column.
- **"Questions for you":** numbered, with **empty inputs and no suggestions**. Examples:
  - VStop length, multiplier and source
  - RSI length
  - near-miss depth (0 = none)
  - **liquidity**, the only question with a shown value: "Yes, ₹10 cr/week" · "Yes, my own floor ₹__" · "No liquidity filter"
- **Register as a Test arm**
  - Title
  - Visibility: Private / Shared
  - Hypothesis (required)
  - Kill criterion (locked after confirm)
- **Buttons:** "Dry run" and "Confirm and assign Prompt ID". Confirm stays disabled with a reason ("Answer 4 questions and add a hypothesis").
- **Unsupported conditions** (when present): a red block listing them. Confirm is disabled until they are removed.

### 3.3 My prompts

- **Tabs:** Mine · Following · Drafts.
- **Prompt table:** Prompt # · Title (with summary) · Structure · Owner · Status and visibility · Graded (N of 13) · Arm vs Control · Followers · Open watchlist / View history.
- **Following tab:** the same table, with the owner shown as "User 2" and so on.
- **Drafts tab:** cards with the draft number, last edit, the start of the prompt text, and what's blocking it ("4 questions left" or "Unsupported: MACD …").
- **Version chain:** for example Prompt 9 → Prompt 12, with "Old versions keep their records and stop being graded".

### 3.4 Explore (sharing — N2, in scope from v3.2)

- **Grid of shared prompts from other users**, plus your own shared ones marked "Yours".
  - Each card: Prompt #, structure, owner, title, condition chips, graded weeks, vs Control, followers.
- **Filters:** structure, "uses condition", and sort (most graded weeks, newest Prompt ID, most followers).
- **Follow / Following ✓ toggle:**
  - Following creates the user's watchlist for (User ID, Prompt ID).
  - Unfollowing archives it; nothing is deleted.
- **Copy to my drafts:** opens a new draft with the prompt text and answers pre-filled. Confirming it creates a new Prompt ID owned by the copier, recorded with "copied from Prompt 15".
- **Followers can't change a prompt's conditions**, and following never creates a Test arm. The arm belongs to the owner's prompt.

## 4. Backend additions this needs (to fold into backend plan v3.3)

| Addition | Detail |
|---|---|
| `prompts.visibility` | `TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','shared'))`. It can change after confirm; it doesn't affect grading |
| `prompt_drafts.copied_from_prompt_id` | `INTEGER REFERENCES prompts(prompt_id)`, set by "Copy to my drafts" |
| `prompts.copied_from_prompt_id` | Carried over at confirm, for lineage across users (separate from `parent_prompt_id`, which is the owner's own versions) |
| Follow = watchlist row | Following inserts `watchlists(user_id, prompt_id)`. The existing `UNIQUE(user_id, prompt_id)` already prevents double-follow. Unfollow sets `archived_at` |
| Access rule | A user can read a prompt, and follow it, only if they own it or it is `shared`. Making a shared prompt private again keeps existing followers' watchlists read-only (archived) |
| Endpoints | `GET /api/explore`, `POST /api/prompts/:prompt_id/follow`, `DELETE /api/prompts/:prompt_id/follow`, `POST /api/prompts/:prompt_id/copy` → `{draft_id}`, `PATCH /api/prompts/:prompt_id/visibility` |
| Follower count | `COUNT(*) FROM watchlists WHERE prompt_id = ? AND user_id <> owner AND archived_at IS NULL` |
| Login | Required once a second user exists (argon2id + session), already planned in backend §8.7 |

## 5. API calls by screen (all ids are integers)

| Screen | Calls |
|---|---|
| New prompt | `POST /api/drafts`, `PATCH /api/drafts/:draft_id`, `POST /api/drafts/:draft_id/compile`, `POST /api/drafts/:draft_id/dry-run`, `POST /api/drafts/:draft_id/confirm` → `{prompt_id, watchlist_id}` |
| My prompts | `GET /api/prompts?view=mine|following`, `GET /api/drafts`, `POST /api/prompts/:prompt_id/edit` → `{draft_id}`, `POST /api/prompts/:prompt_id/retire` |
| Watchlist | `GET /api/watchlists/:watchlist_id`, then `POST /api/quotes` on open and on Refresh |
| Detail | `GET /api/watchlists/:watchlist_id/entries/:entry_id`, `PATCH …` (note / remove) |
| Explore | `GET /api/explore`, follow / unfollow, copy |

## 6. UI rules

- **Never imply live data.** Every price shows its as-of time and source.
- **Graded vs not graded is always visible:**
  - near misses carry "not graded"
  - validation says "arm picks only"
  - dry runs say "not recorded in the forward test"
- **Provenance is always visible.** Every condition shows whether it came from the prompt or from the user's answer.
- **Ids are numbers.** "Prompt 12" and "Draft 58"; the copy button copies just the number.
- **Accessibility:**
  - real buttons, labels and fieldsets
  - 44 px main touch targets
  - status is never shown by color alone (chips carry text)
  - blue / amber, not red / green, for distinctions that matter

## 7. Phases (match the backend)

| Phase | Frontend scope |
|---|---|
| P1 | Watchlist (tabs, status, dynamic condition columns, prices bar, detail); manual draft form (structure + condition rows + questions); confirm → Prompt ID |
| P2 | My prompts (Mine / Drafts, version chain), validation card, entry timeline |
| P3 | Prompt reading with the compiler: "How it was read", questions, unsupported block |
| P4 | Sharing: visibility toggle, Explore, Follow / Unfollow, Copy to my drafts, Following tab, multi-user login |
