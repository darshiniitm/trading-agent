# Prompt Screener — UI implementation plan (P5: build the canvas)

Status: plan, 08 Oct 2026. For Claude Code to implement in `.claude/worktrees/prompt-screener-frontend/frontend/apps/web`.

> **For agentic workers:** Work task by task (§7). Steps use checkbox (`- [ ]`) syntax. Each task ends with `npm test` green in `apps/web`.

**Goal.** Make the working app look and behave like the **"Prompt Screener Dashboard" design canvas** (v3.2, 4 screens: Watchlist, New prompt, My prompts, Explore). P1–P4 delivered every route, API and server module, but the pages are unstyled HTML: there is no CSS file anywhere in `apps/web`. This phase is presentation plus the few read-model fields the canvas shows that the API doesn't return yet. It changes no grading, recording or compiler logic.

**Inputs, in order of authority (newest wins):**
1. `docs/prompt-agent-interpreter-plan.md` v1 (07 Oct) and the code built from it (`InterpretationView`, `DraftEditor`: open slots are filled and shown as editable chips; nothing blocks the run).
2. `docs/prompt-compiler-any-prompt-plan.md` **D12** (07 Oct): no Literal / T1-literal structures, no near misses, no selection-point re-check.
3. `docs/prompt-screener-frontend-plan.md` v3.2 (03 Oct): screens, UI rules §6.
4. The design canvas (03 Oct): the visual system and layout. It was drawn **before** D12, so §2 lists every place it must be adapted.

**Stack (unchanged, frontend plan §2).** Next.js 14 app router, TypeScript, TanStack Query (already a dependency, not yet used by pages), zod from `packages/spec`, hand-written SVG charts. **New:** CSS Modules plus one `tokens.css`. No Tailwind, no component library, no chart library. Fonts are IBM Plex Sans and IBM Plex Mono, loaded with `next/font/google`.

---

## 1. Decisions needed before Task 3 (defaults used if unanswered)

| # | Question | Default this plan builds |
|---|---|---|
| U1 | **Structure badge** ("Literal" / "T1-literal" on the canvas). **Decided 08 Oct: remove the component.** | No structure badge anywhere: not on the Watchlist header, not in My prompts, not on Explore cards. The My prompts "Structure" column and the Explore "Structure" filter are removed with it. The `structure` field can stay in the API responses (v4 rows), but the UI never renders it. |
| U2 | **Near misses.** The canvas has a Near-miss tab, "Near miss" tags and a "Shadow on watchlist" KPI. D12 removed near misses, but the schema still has `membership = 'near_miss'` and v4-era rows may exist. | **Data-driven.** The tab, the tag and the KPI render only when the watchlist actually has near-miss entries. A v5 prompt never shows them. The KPI slot shows "Unevaluated" (stocks with missing data) instead. |
| U3 | **New prompt: questions or chips?** The canvas shows numbered questions with empty inputs and a disabled Confirm (D6). The current code fills open slots and shows them as editable chips; nothing is asked and nothing blocks (interpreter plan §5, decision 1). | **Keep the code's behaviour** and give it the canvas look. Every filled-in value is a chip with a **third provenance style**: amber dashed outline labelled "filled in — check". It stays visibly different from "from prompt" (grey dot) and "your answer" (amber dot). Saving is allowed. The save bar lists "N values filled in, not from you" so they are never silent. |
| U4 | **Hypothesis.** It is required on the canvas but optional in the code. | Optional (matches the code). The kill criterion still locks after save. |
| U5 | **Entry statuses.** The canvas has "Selection Mon (date)" and "Not confirmed at open", which come from the re-check D12 removed. | `StatusChip` keeps the full `status` enum and its labels, so v4 rows still render. New v5 runs only produce `entered` / `pending_selection` / `watching` / `dropped_from_screen`. Nothing is hard-coded to Monday: the "Next selection" KPI reads the program's `trade_plan.entry.at`. |
| U6 | **Home route.** `/` redirects to `/drafts/new` today. | Redirect to `/prompts` (My prompts), which is the canvas's first nav item. |
| U7 | **Return colours.** The canvas colours returns green/red, but frontend plan §6 says blue/amber for distinctions that matter. | Keep green/red **only** for signed returns. They always carry a `+` / `−` sign, so colour is never the only cue. Membership, provenance and status use blue/amber/grey per §6. |

---

## 2. Canvas → current app: what is kept, adapted or dropped

| Canvas element | Where it lives now | P5 action |
|---|---|---|
| Header: logo, nav (My prompts · New prompt · Explore), user badge "1 · User 1 (you)" | none | **Build** `AppShell` in `app/layout.tsx`. Add Data health as a 4th, quieter nav item, plus a sign-out link when more than one user exists |
| Watchlist header: Prompt #, structure badge, "Shadow arm · graded vs Control", owner · visibility · followers · version · confirmed date | only `title`, `structure` | **Adapt.** Drop the structure badge (U1). Extend the watchlist API (§5) |
| Actions: Edit as new version · Export CSV · Dry run now (tooltip "not recorded in the forward test") | none on the watchlist page | **Build.** Edit uses `POST /api/prompts/:id/edit`. Export CSV is client-side from the loaded rows. Dry run uses the existing `program/screen` route with `kind = dry_run` and shows the result in a dialog |
| Prompt card: prompt text, condition chips with provenance dots, "Structure steps used" line | conditions as a `<ul>` | **Adapt.** Chips from `prompt_conditions` with `valueOrigin`. The "steps used" line becomes **"What runs"**, built from `lastRun.appliedSteps` (or the program's sets and actions) |
| Prices bar: "Prices as of … · Yahoo Finance · may be delayed · last trade …" + Refresh | plain `<p>` | **Restyle.** Add a debounced Refresh (1 s) and per-symbol stale tags (backend §6) |
| KPI row ×4 | none | **Build** (computed client-side from entries and quotes). The third KPI follows U2 |
| Table: tabs, search, Stock · LTP · Today · Added · Status · Since entry · C1–Cn flags · Entry/Stop · 12-wk sparkline | `WatchlistTable` with a column per condition | **Rebuild** as a CSS-grid list of row buttons, as drawn. Condition flags are 14 px squares (filled = met, amber outline = not met) with a `title` and a visually hidden "C3 not met". Needs `chg_pct` (§5 G1) and 12-week closes (§5 G2) |
| Detail side panel | separate route `/watchlists/:id/entries/:entryId` | **Move into the watchlist page** as an `<aside>`, selected with `?entry=<id>`. The old route stays and renders the same panel full-width (deep links keep working) |
| Validation card: 1 / 2 / 3-week tiles vs Control | `ValidationCard` table | **Restyle** to 3 tiles. Keep the text "arm picks vs Control only" and "graded week N of 13" (tests rely on them) |
| New prompt: draft label, autosave, prompt box, "Read my prompt", Structure radios, "What will run", "How your prompt was read", Questions, Register as Test arm, Dry run / Confirm | `DraftEditor` + `InterpretationView` (440 lines) | **Adapt** (U3, U4). Drop the Structure radios (D12). "What will run" = the template-rendered English (interpreter §3.2). "How it was read" = the existing clause table. Questions = open chips plus the liquidity / min-price / ASM add-ons. Add the visibility toggle |
| My prompts: tabs Mine · Following · Drafts, prompt grid, draft cards, version chain | `app/prompts/page.tsx` (lists + `VersionChain`) | **Restyle.** Drop the Structure column (U1) |
| Explore: filters, card grid, Follow toggle, Copy to my drafts | `app/explore/page.tsx` (one line of JSX) | **Rebuild** as drawn, without the Structure filter or the structure pill (U1). The "uses condition" text input becomes a select fed from the KB registry names |
| "Illustrative data" pill | canvas only | **Drop** (real data) |
| Data health, login, signup, `DataStatus` chips | unstyled | **Restyle** with the same primitives (not on the canvas) |

---

## 3. Design system (taken exactly from the canvas)

Dark theme only, as drawn. Light mode is out of scope. Write these as CSS custom properties in `app/tokens.css` and never use raw hex values in components.

### 3.1 Colour tokens

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D1117` | page |
| `--surface-0` | `#0F141B` | header, inputs, inner tiles, prices bar |
| `--surface-1` | `#131922` | cards, table panel |
| `--surface-nav-active` | `#1C2330` | active nav item |
| `--surface-chip` | `#262F3D` | Prompt # badge, active segment, avatar |
| `--row-hover` | `#18202B` | table row hover |
| `--row-selected` | `#1E2836` | selected row |
| `--selected-blue-bg` | `#0F1A2A` | selected radio card / current version |
| `--border` | `#262C36` | card borders |
| `--border-strong` | `#2F3846` | inputs, secondary buttons, chips |
| `--divider` | `#1F2630` | row separators |
| `--border-dashed` | `#3A4352` | draft badge (dashed), neutral pills |
| `--text` | `#E6EDF3` | primary text |
| `--text-2` | `#C9D1D9` | secondary values |
| `--muted` | `#9AA4B2` | labels, captions |
| `--accent` / `--accent-hover` / `--on-accent` | `#F0B429` / `#FFD166` / `#14110A` | primary button, condition ids, links |
| `--accent-disabled-bg` / `-fg` | `#3A3320` / `#A89A70` | disabled primary |
| `--blue` / `--blue-text` | `#58A6FF` / `#79B8FF` | info, selection-pending, selected outline |
| `--amber` / `--amber-text` | `#F2A541` / `#F2C14E` | not met, missing "?", warnings |
| `--warn-border` / `--warn-bg` / `--warn-fg` | `#8A6417` / `#1A1508` / `#E6DCC4` | questions card, watchlist-only banner |
| `--orange` | `#D18616` | near-miss tag border |
| `--positive` / `--negative` | `#3FB950` / `#FF7B72` | signed returns, "met" ticks, Following ✓ |

### 3.2 Type, space, shape

- **Fonts:** IBM Plex Sans 400/500/600/700 for UI; IBM Plex Mono 400/500/600 for every number, ticker, id, price and the prompt text.
- **Type scale:** 26/700 (h1) · 22/600 (KPI small) · 28/600 mono (KPI) · 30/600 mono (detail price) · 17/600 (card title) · 16/600 (h2) · 14 (body) · 13 · 12.5 · 12 (caps labels: uppercase, letter-spacing 0.6–0.8 px, `--muted`).
- **Spacing:** 4 · 6 · 8 · 10 · 12 · 14 · 16 · 18 · 20 · 24 · 28. Page padding is `24px 28px 48px`, `max-width: 1440px`.
- **Radii:** 6 (nav, segments, small badges) · 8 (buttons, inputs, tiles) · 10 (cards) · 999 (pills).
- **Controls:** primary and main buttons are 44 px tall. Secondary buttons 40 px, in-table buttons 36 px, inputs 40 px.
- **Icons:** inline stroke SVG at stroke-width 2, as on the canvas (logo, clock, refresh, search, info). No emoji. `✓` / `—` are text glyphs and stay.

### 3.3 Primitives (`src/ui/`, one file + one `.module.css` each)

| Component | Props / variants | Canvas source |
|---|---|---|
| `AppShell` | `active: 'prompts' | 'new' | 'explore' | 'data'`, current user | header on every board |
| `Button` | `variant: primary | secondary | accentOutline | ghost`, `size: 44 | 40 | 36`, `disabledReason` (rendered as visible text, not just `title`) | Confirm, Edit, Dry run now |
| `Pill` | `tone: neutral | blue | amber | orange | positive | negative`, `dashed` | status chips, badges |
| `IdBadge` | `kind: prompt | draft`, `id: number`; draft is dashed. A copy button copies the number only (§6 rule) | "Prompt 12", "Draft 58" |
| `Segmented` | `items: {id,label,count}[]`, `value`, `onChange`; renders `aria-pressed` buttons | tabs on Watchlist / My prompts |
| `Card` | `tone: default | warn`, `title`, `aside` | every section |
| `Kpi` | `label`, `value`, `note`, `tone` | KPI row |
| `ProvenanceDot` | `origin: prompt | user_answer | user_convention | assumed` (grey / amber / amber-ring / amber dashed per U3) | prompt card legend |
| `ConditionChip` | id, text, origin | prompt card chips |
| `ConditionFlags` | `conds: {id,label,met}[]`; prints `n/N` | table C1–Cn |
| `Sparkline` | `values: number[]`, 88×28 | 12-wk column |
| `PriceChart` | weekly closes + up to 2 overlay series (e.g. VStop long/short); 320×150 viewBox, responsive width; legend below | detail panel |
| `LevelTiles` | `tiles: {label,value}[]` (2-col grid) | detail panel |
| `Banner` | `tone: warn | info`, icon + text | "Watchlist only…" |
| `FieldText`, `FieldNumber`, `FieldSelect`, `FieldTextarea`, `RadioCard`, `SegmentedRadio` | always a real `<label>`; mono for numbers | New prompt form |
| `GridTable` | column template string, header row, row renderer, horizontal scroll box with `min-width` | all tables |
| `Dialog` | native `<dialog>` with focus return | dry-run result, retire confirm |

---

## 4. Screens

Each screen keeps every accessible name and every text string the current tests query. Run `grep -rn "getBy" tests/components` before changing copy. The strings that must survive include: "Read my prompt and run it", "Save and assign Prompt ID", the `hypothesis` and `kill criterion` labels, "dry run result", "arm picks vs Control only", "graded week N of 13", "near misses are not graded", "stop being graded", "watching … not graded" and "not counted in forward-test scoring".

### 4.1 Watchlist — `/watchlists/[watchlistId]` (canvas board "Watchlist · Prompt 12")

Layout top to bottom: title block + actions → prompt card → prices bar → KPI row (auto-fit, min 220 px) → table (`flex: 999 1 640px`) beside the detail aside (`flex: 1 1 340px`; wraps under the table below ~1000 px) → validation card.

- **Header.** `IdBadge` · Pill "Shadow arm · graded vs Control" · h1 title · meta line "Owner: you · Shared · 1 follower · version 2 (replaces Prompt 9) · confirmed 26 Sep". A follower sees "Owner: User 2" and **no** Edit button (followers can't change conditions).
- **Prompt card.** Prompt text in mono, quoted. Then `ConditionChip`s C1…Cn plus trade-plan chips ("Entry …", "Stop from C2"), with the legend for the provenance dots. Last, the **"What runs"** line: ✓ items from the applied steps and actions; — items for the trade-plan parts the prompt didn't set ("Risk cap: not in prompt").
- **Prices bar.** "Prices as of **HH:MM**" uses the **newest** quote `asOf`, never the wall clock. Then "· Yahoo Finance · may be delayed · last trade <last bar date from /api/health>". The Refresh button is debounced, disabled while fetching, and announces the result in an `aria-live="polite"` region. Failed symbols show the cached price with a `stale` pill.
- **KPI row.** (1) Arm picks: count of `full_match`; note "x entered · y pending · z not confirmed" (only the non-zero parts). (2) Avg since entry: equal-weight of entered picks, `(ltp − entry)/entry`, labelled "Equal-weight, n entered picks"; "—" when n = 0. (3) Per U2. (4) Next selection: from the run schedule (next completed bar for the program's timeframe) and `trade_plan.entry.at`.
- **Table.** Columns are as drawn. Condition flag columns come from the prompt's own conditions, so their count varies. The "Since entry" cell shows `+x.x%` for entered picks, `+x.x% ref` for shadow rows and "—" otherwise. Rows are `<button>`s that set `?entry=`; arrow up/down moves the selection while the list has focus. Search filters by symbol or name, client-side. Empty state: "No stocks in this view."
- **Detail aside.** Symbol + status pill · name · sector · "added <date> run" · warn `Banner` for any non-`full_match` row · price + day change · `PriceChart` drawn with **the prompt's own** indicator params (from `/series`) · "Your conditions" list (tick or ✗, label, actual value from `condValues`) · `LevelTiles` that switch by status, exactly as the canvas's four cases (entered / pending / not confirmed / shadow), with the D12 cases reduced per U5 · personal note (PATCH, saved on blur, "Saved" status text) · "Remove from my watchlist" (confirm dialog; affects only this user) · `EntryTimeline` (collapsed `<details>` "History").
- **Validation card.** Three tiles: 1, 2 and 3 weeks. Each shows the arm's equal-weight return with "Control +x.x%" beside it, or "Pending" with "After Fri DD Mon close". Subtitle: "Graded week N of 13 · picks from the <date> run · near misses are not graded".

### 4.2 New prompt / draft — `/drafts/new`, `/drafts/[draftId]` (board "New prompt (draft)")

Two columns (`flex: 1 1 520px` and `1 1 600px`), wrapping on narrow screens.

- **Top.** Dashed `IdBadge` "Draft 58 · not yet numbered" · "Autosaved HH:MM" (PATCH debounced 800 ms on text change; the status text updates). h1 "New prompt". Intro line from the canvas.
- **Left column.** "Your prompt" textarea (mono, 6 rows) → button **"Read my prompt and run it"** (keep that exact name) + "Last read HH:MM · n rules · m values filled in" → card **"What will run"**: the template-rendered English from the program (interpreter §3.2), with ✓ / — per set and action → card **Dry-run result** (the existing `dry run result` region, restyled with `GridTable`).
- **Right column.** Card **"How your prompt was read"**: the existing clause table. Columns are # · Your words · Became · Status. "Not used" rows are dimmed at 55 % opacity with the reason. Missing values show as an amber "?" chip. → **warn card "Values to check · N"**: the open chips (U3) as labelled fields, plus the liquidity / min-price / ASM-GSM add-ons. Liquidity keeps its three explicit choices ("Yes, ₹10 cr / week" · "Yes, my own floor ₹__" · "No liquidity filter"). → card **"Register as a Test arm"**: Title, Visibility (Private / Shared segmented radio; applied by `PATCH /api/prompts/:id/visibility` right after save), Hypothesis, Kill criterion ("locked after save"). → **action bar**: "Dry run" (secondary) and **"Save and assign Prompt ID"** (primary). The block reason is shown as visible amber text next to the button, not only as a `title`.
- **Unsupported / not computable.** A red-bordered `Banner` lists them ("recognised: Ichimoku Cloud, not computable yet").

### 4.3 My prompts — `/prompts` (board "My prompts")

- Title row with the primary button "New prompt" on the right.
- `Segmented` with counts: Mine n · Following n · Drafts n.
- Mine / Following: `GridTable` (min-width 1080) with Prompt # (mono) · Title + sub-line · Owner · Status pill + visibility · Graded "n of 13" · Arm vs Control (signed, coloured) · Followers · action ("Open watchlist" or, for superseded / retired prompts, "View history"). The row menu keeps Edit as new version and Retire (with a confirm `Dialog`).
- Drafts: card grid (min 320 px) with the dashed draft id, "Edited …", the first ~120 characters of the prompt in mono, the block note (amber when it's values to check, red when unsupported), and "Continue".
- **Version chain card** for the selected prompt's lineage: boxes joined by arrows; the current one has a blue outline. The text "Old versions keep their records and stop being graded. Nothing is rewritten." stays.

### 4.4 Explore — `/explore` (board "Explore & follow")

- Intro paragraph with **Follow** and **Copy to my drafts** in bold, as on the canvas.
- Filters row: Uses condition (select from registry names) · Sort (Most graded weeks · Newest Prompt ID · Most followers). Right-aligned note: "graded weeks are shadow (paper) results".
- Card grid (`auto-fill, minmax(380px, 1fr)`). Each card: Prompt # badge · "by owner" · title · condition chips · three tiles (Graded · vs Control · Followers) · actions. For your own prompt: "Yours · open watchlist". Otherwise: **Follow / Following ✓** (`aria-pressed`, optimistic toggle that rolls back on error) and **Copy to my drafts**.

### 4.5 Not on the canvas, restyled with the same primitives

`/data-health` (`DataHealthView`), `DataStatus` chips (`FeasibilityChip`, `RunHeader`, `UnevaluatedSection`, `UploadControl`), `/login`, `/signup` (centred 400 px card) and `AuthGate`.

---

## 5. API / engine gaps the canvas needs

| # | Gap | Change | Test |
|---|---|---|---|
| G1 | "Today" % column and the detail day change | Engine `/quotes`: also return `prev_close` from the same yfinance call. `getQuotes` adds `chgPct` (the `quotes.chg_pct` column already exists in the DDL) | `quotes.test.ts`: `chgPct` is computed; null when there is no `prev_close` |
| G2 | 12-week sparklines for every row | New `POST /api/series/closes {symbols, weeks: 12}` → `{symbol: number[]}`. It calls engine `GET /series/{symbol}` in a bounded pool (concurrency 4) and caches per symbol per last bar date | route test with a mocked engine; a cache hit makes no second engine call |
| G3 | Detail chart overlays with the prompt's params | `GET /api/watchlists/:id/entries/:entryId/series` → engine `/series/{symbol}` with the indicator params taken from that prompt's conditions | asserts the params are passed through unchanged |
| G4 | Watchlist header and meta | `getWatchlistView` adds `promptText`, `ownerName`, `isOwner`, `visibility`, `followers` (frontend plan §4 query), `version`, `parentPromptId`, `confirmedAt`, `whatRuns[]` | `watchlists.test.ts` |
| G5 | Row name / sector / added / entry date | Each entry adds `name`, `sector` (from `symbols`), `addedAsOf` (the `as_of` of `first_run_id`), `entryDate` | `watchlists.test.ts` |
| G6 | Condition labels | Move `ruleLine` out of `InterpretationView` into `src/lib/conditionLabel.ts`, shared by the chips, flags, detail list and Explore cards | existing `InterpretationView` tests + a new unit test |
| G7 | Validation tile captions | `getValidationSummary` adds the graded run's `as_of` and, for each pending horizon, the date it becomes due | `validations.test.ts` |
| G8 | Explore card chips | `listExplore` returns `conditionLabels[]`. The `structure` query param stays accepted (ignored by the UI), so existing tests don't break | `phase4.test.ts` |

No schema migration is needed: every field already exists or is derived.

---

## 6. Global constraints

- **No logic changes** in `weeklyScreen`, `selectEntry`, `validatePrior`, the compiler, `confirm` or any grading path. P5 is a read-model change plus presentation only.
- **Frontend plan §6 UI rules hold everywhere:** never imply live prices; graded vs not graded always visible; provenance always visible; ids are numbers; status never shown by colour alone.
- **Accessibility.** Real `<button>`, `<a href>`, `<label>`, `<fieldset>`/`<legend>`. Visible focus ring: 2 px `--blue` outline with offset 2. Every icon-only control has an `aria-label`. Text contrast ≥ 4.5:1: check `--muted #9AA4B2` on `--surface-1` and the amber texts on `--warn-bg`. Honour `prefers-reduced-motion`.
- **Responsive.** It must work at 390 px wide: the header nav wraps, the two-column layouts stack, the KPI grid goes to one column, and wide tables scroll inside their own box. The page itself never scrolls horizontally.
- **Existing tests stay green unmodified,** except where a test asserts the Structure / Literal badge, column or filter that U1 removes; update those in the same commit and say so in the commit message.
- **Never hard-code dates or weekdays.** Every date shown comes from the data (`as_of`, `asOf`, `/api/health.last_bar_date`).

---

## 7. Tasks

### Task 0 — Decisions
- [ ] Record the answers to U1–U7 at the top of this file (or confirm the defaults).

### Task 1 — Tokens, fonts, shell
Files: `app/tokens.css` (NEW), `app/globals.css` (NEW: reset, body, focus ring, links), `app/layout.tsx` (MODIFY: fonts, `AppShell`, `QueryClientProvider`), `src/ui/AppShell.tsx` + `.module.css` (NEW), `app/page.tsx` (MODIFY per U6).
- [ ] Write the §3.1 tokens and the §3.2 scale as variables.
- [ ] Load IBM Plex Sans and Mono with `next/font/google` and expose them as `--font-sans` / `--font-mono`.
- [ ] Build `AppShell`: active nav item from `usePathname()`; user badge from `/api/auth/me`.
- [ ] Add `app/providers.tsx` (client component) with a TanStack `QueryClient` (`staleTime` 30 s; quotes use their own 60 s cache).
- Done when every page renders inside the shell, dark, in Plex, with tests green.

### Task 2 — Primitives
Files: `src/ui/*` per §3.3, `tests/components/ui/*.test.tsx`.
- [ ] Build each primitive with its CSS Module. No inline hex values.
- [ ] Tests: `Segmented` sets `aria-pressed`; `Button` with `disabledReason` shows the reason text; `ConditionFlags` prints "2/4" and its hidden "not met" text; `IdBadge` copy writes just the number.

### Task 3 — Watchlist read model (G1, G2, G4, G5, G6, G7)
Engine worktree: `engine/quotes.py`, `engine/app.py`. Web: `src/server/watchlists.ts`, `src/server/quotes.ts`, `src/server/validations.ts`, `src/lib/conditionLabel.ts`, `app/api/series/closes/route.ts`.
- [ ] Implement each gap with its test from §5.

### Task 4 — Watchlist page (§4.1)
Files: `app/watchlists/[watchlistId]/page.tsx` (REWRITE with Query), `src/components/watchlist/{Header,PromptCard,PricesBar,KpiRow,WatchlistGrid,DetailPanel,ValidationTiles}.tsx`; `WatchlistTable.tsx` becomes `WatchlistGrid` (keep the export name `WatchlistTable` as a re-export so existing imports and tests resolve).
- [ ] Build the layout and components exactly as the canvas, with U2 and U5 applied.
- [ ] Selection lives in `?entry=` via `useSearchParams`; the old entry route renders `DetailPanel` full-width (Task 8).
- [ ] Export CSV: client-side, one row per visible entry, columns as the table, with the prices as-of time in the header row.
- [ ] Dry run now opens a `Dialog` with the result and the line "Not recorded in the forward test".
- Done when the page matches the canvas board at 1440 px with real data, works at 390 px, and the watchlist tests pass.

### Task 5 — New prompt / draft (§4.2)
Files: `src/components/DraftEditor.tsx`, `src/components/InterpretationView.tsx` (split into `ReadingTable`, `ValuesToCheck`, `AddOns`, `DryRunResult`, keeping its public props), `src/components/draft/RegisterArm.tsx`.
- [ ] Two-column layout, autosave status, provenance styles per U3, visibility applied after save.
- [ ] Keep every accessible name the 4 component test files query.

### Task 6 — My prompts (§4.3)
Files: `app/prompts/page.tsx`, `src/components/VersionChain.tsx`, `src/components/prompts/{PromptGrid,DraftCards}.tsx`.
- [ ] Segmented tabs with counts, the grid, draft cards, the version chain, a retire dialog.

### Task 7 — Explore (§4.4, G8)
Files: `app/explore/page.tsx` (REWRITE), `src/components/explore/PromptCard.tsx`, `src/server/explore.ts`.
- [ ] Filters, card grid, optimistic follow with rollback, copy → `/drafts/:id`.

### Task 8 — Remaining pages
- [ ] The entry route renders `DetailPanel` full-width with a "Back to watchlist" link.
- [ ] Restyle `/data-health`, `DataStatus`, `/login`, `/signup`, `AuthGate`.

### Task 9 — Check against the canvas
- [ ] Run the app with seeded data (`src/server/db/seed.ts` extended with: one entered, one pending, one watching v4 row, two followers, a version chain, two drafts).
- [ ] Screenshot every route at 1440 and 390 px (Playwright, `scripts/ui-screens.ts`) and compare side by side with the canvas boards. Fix the differences.
- [ ] Accessibility pass: keyboard-only walk through every screen; axe check with `@axe-core/playwright` (dev dependency), zero serious violations.
- [ ] `npm test` and `npm run build` are green.

---

## 8. Review focus

- **A v5 prompt's watchlist never shows near-miss UI** (U2), and a v4 prompt with near-miss rows still shows them with "not graded" on each.
- **The "as of" time on the prices bar is the newest quote's timestamp,** never `new Date()` (the canvas mock used the wall clock; that would imply live data).
- **A follower's watchlist** has no Edit button, no visibility toggle, and a working "Remove from my watchlist" that doesn't touch the owner's list.
- **Filled-in values on a draft** (U3) are visibly different from prompt values and from user answers on the draft, on the watchlist chips and in Explore.
- **Nothing in P5 writes to `runs`, `run_results` or `validations`,** except Dry run now, which writes `kind = dry_run` through the existing route.
