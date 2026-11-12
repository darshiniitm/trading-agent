# NSE Screener as a Claude plugin — implementation plan

**Status:** plan v1.0, 15 Oct 2026 — for Claude Code to implement. Nothing here is built yet.
**Owner decisions (Dharmin, 15 Oct 2026):**
- Users run the workflow on **their own Claude subscription**, not on our API key or model hosting.
- Distribute it as a **Claude plugin**, not a hosted connector.
- We maintain the **engine** only; the web frontend isn't needed for this route.

**Relationship to `docs/production-deployment-plan.md`:** that plan (Hugging Face + a hosted server) is not needed for this route. The local Ollama web app and its evals stay as they are for our own development.

---

## 1. The core idea

The plugin brings two things into the user's Claude: **a skill** (how to turn an English strategy into our ScreenProgram) and **the engine** (a small local tool server that screens NSE stocks on the user's own computer).

```
User types a strategy in Claude (Claude Code, or a Cowork task on the desktop app)
  → the plugin's skill tells Claude how to read it into a ScreenProgram v5
  → Claude calls the plugin's local engine tools: check_program → run_screen → save_screen
  → the engine, running on the user's computer, fetches NSE data, screens and returns the watchlist
  → Claude shows the result; saved screens re-run weekly on the user's computer
```

What this gives us:
- **No model bill, no API key, no model hosting.** Claude does the interpreting, on the user's plan.
- **No server to run.** No hosting, no sign-in system, no user database, no backups on our side. Each user's screens, watchlists and forward-test records live in a folder on their own computer.
- **No frontend.** Claude's chat is the interface.
- **Data is fetched by each user for their own use.** We don't redistribute market data. (This doesn't remove the regulatory question in §8.)

## 2. What the plugin format supports (Claude docs, checked 15 Oct 2026)

| Plugin component | Claude Code | Cowork (desktop app) | Chat (claude.ai web / mobile) |
|---|---|---|---|
| Skills (`skills/<name>/SKILL.md`) | Loads | Loads | Loads |
| **Local MCP server** (a command the app starts) | Loads | Loads when the Cowork session runs on the user's computer | **Ignored** |
| Commands (`commands/*.md`) | Loads | Loads (`/plugin-name:command`) | Loads as a skill |
| Hooks, agents | Loads | Loads | Ignored |
| Executables in a top-level `bin/` | Loads | **Can't be installed** — the whole plugin is refused | **Can't be installed** |

So:
- **Supported surfaces: Claude Code and Cowork on the desktop app.** Both run on the user's computer, so the local engine runs there. Plain claude.ai chat in a browser or on a phone has no local engine, so it can't run screens. §9 covers the optional add-on if that's needed later.
- **Never put anything in a top-level `bin/`.** That makes Cowork and Chat refuse the plugin.
- Install: Claude Code runs `/plugin marketplace add <owner>/<repo>` and then `/plugin install`. Cowork users go to **Customize → Plugins** and add the GitHub marketplace repo, or upload a zip of the plugin. A plugin installed on the claude.ai account also syncs into Claude Code.
- Limits: 5,000 files and 200 MB per plugin. The engine code fits easily; **data caches must never be bundled** — they're built on the user's machine on first run.

## 3. What we already have

- **Engine (Python, `engine/`):** FastAPI routes `/conditions/v5`, `/feasibility`, `/screen/v5`, `/select`, `/arms/register`, `/arms/{id}/retire`, `/validate`, `/quotes`, `/series/{symbol}`, `/history/{symbol}`, `/metrics`, `/fundamentals`; data refresh and prefetch; the v5 evaluator in `engine/v5/`; resolution in `engine/resolution/`.
- **The IR:** `engine/v5/program.py` — ScreenProgram v5, pydantic with `extra="forbid"`, so an invented key or a wrong operator is rejected and named. **This is the guardrail on Claude's interpretation.**
- **Compiler (TypeScript, `frontend/apps/web/src/server/compiler/v5/`):** mostly deterministic recognisers with a model fallback. It lives in the Node app, so it isn't in the plugin for v1 (see §4.3).
- **Golden set:** `tests/golden/` — 20 real-world strategy prompts with golden answers on real NSE data.
- **Weekly logic:** catch-up, grading and step-5 validation in the app layer (`npm run jobs:catch-up`) and `src/`/`tests/track_*`. The parts the plugin needs move behind engine tools (§4.2).

## 4. Design

### 4.1 Plugin layout

```
nse-screener-plugin/                       (its own GitHub repo, also the marketplace)
  .claude-plugin/
    plugin.json                            name "nse-screener", version, description
    marketplace.json                       lists this one plugin
  .mcp.json                                the local engine (below)
  skills/
    screen-strategy/SKILL.md               English prompt → ScreenProgram → run → save
      references/capabilities.md           fields, indicators, operators, timeframes, universes
      references/examples/*.json           golden prompt → program pairs
    weekly-run/SKILL.md                    run the weekly catch-up and report
    review-results/SKILL.md                watchlist views, forward results, step-5 check
  engine/                                  the Python package (synced from trading-agent)
    pyproject.toml                         deps pinned; entry point nse-screener-mcp
    nse_screener/...
  README.md                                install, first run, where data lives, disclaimer
```

`.mcp.json`:

```json
{ "mcpServers": { "nse-screener": {
    "command": "uv",
    "args": ["run", "--project", "${CLAUDE_PLUGIN_ROOT}/engine", "nse-screener-mcp"],
    "env": { "NSE_SCREENER_HOME": "${HOME}/.nse-screener" } } } }
```

- `uv` builds an isolated Python environment the first time it runs, with no manual `pip`. Phase 0 confirms `${CLAUDE_PLUGIN_ROOT}` and `${HOME}` expand on both Claude Code and Cowork; if `uv` can't be assumed, the fallback is a `.mcpb` bundle (listed as supported for local servers) or a one-time setup command.
- **No `${user_config.*}` values** in `.mcp.json` — Cowork doesn't prompt for them and would skip the server.
- All state lives under `~/.nse-screener/`: `screens.db` (SQLite: screens with numeric IDs, watchlists, runs), `records/` (immutable weekly records), `cache/` (price data). Nothing is written inside the plugin folder, because plugin updates replace it.

### 4.2 The local engine: an MCP server over stdio

A new thin layer, `engine/mcp_server.py` (official Python MCP SDK), that calls the **same functions** the FastAPI routes call, so the logic isn't duplicated and the web app and plugin share one engine.

| Tool | Does | Backed by |
|---|---|---|
| `get_capabilities` | Fields, indicators, operators, timeframes, universes, defaults (also an MCP resource) | `conditions_payload()` |
| `check_program(program)` | Schema check + feasibility, errors keyed by condition id | pydantic `ScreenProgram`, feasibility |
| `run_screen(program, as_of?)` | Dry run: qualified stocks, near-misses, sector grouping, trade plan (SL, EP, confidence) | `run_program`, `select_legacy` (dry run) |
| `save_screen(program, title, prompt)` | Saves it with a numeric ID, registers the arm, creates the watchlist, keeps the prompt details (prompt, final program, tools used) | `register_arm`, local DB |
| `list_screens()` | Saved screens and their status | local DB |
| `get_watchlist(screen_id, view)` | One watchlist in one view: Price, Financials, Performance, Risk or Technicals | metrics service |
| `get_results(screen_id)` | Weekly forward results and the step-5 check (last week's picks' 1-, 2- and 3-week returns) | `validate_legacy`, records |
| `run_weekly()` | Catch-up: record and grade every active screen for every closed week missed, obeying the pre-open rule | ported catch-up logic |
| `retire_screen(screen_id)` | Stops weekly runs for one screen | `retire_arm` |
| `lookup_stock(symbol)` | Quote, history, which conditions it meets | quotes, series, history |
| `data_status()` / `refresh_data()` | Cache health; first-run or manual data refresh, with progress | data health, prefetch, refresh |

- Mark read-only tools with `readOnlyHint`; `save_screen`, `retire_screen`, `run_weekly` and `refresh_data` change state, so Claude asks first.
- Keep responses compact (top 20 rows plus counts, full table on request) to save the user's context and usage.
- The first `refresh_data` (full NSE universe) is long and network-heavy. Run it in the background inside the server and report progress through `data_status`, rather than blocking one tool call.

### 4.3 Interpretation: the skill replaces our model calls

`skills/screen-strategy/SKILL.md` carries the 7 Oct interpreter decisions:
1. Read the user's prompt line by line. For each condition, work out parameter, operator, value, trigger point and data range from `references/capabilities.md` and `get_capabilities`.
2. **Use only the user's conditions.** Suggested extras are clearly marked optional and never added silently.
3. **No blocking questions.** Ask only for a slot that is genuinely missing, and never ask the user to supply new conditions. Otherwise fill gaps from defaults and say which defaults were used.
4. `check_program` → fix exactly the condition it names → repeat until clean.
5. `run_screen`; show results grouped by sector with SL, EP and confidence; then offer `save_screen`.
6. Say it's a research screener, not investment advice.

**The TypeScript compiler is not shipped in v1.** Claude reads the prompt itself, with the golden examples as worked references and the schema as the guardrail. If Phase 3's eval shows Claude alone scores below our current best, add a `compile_prompt` tool by porting the deterministic recognisers to Python (or bundling the compiler as a single JS file — only if Node can be assumed on users' machines, which Claude Code's native installer no longer guarantees).

### 4.4 Weekly runs on the user's computer

Saved screens need a weekly record after Friday's close and the Monday-open check, and the computer has to be awake then.
- **Primary:** the plugin's `weekly-run` skill, set up as a weekly scheduled task in the user's Claude. It calls `run_weekly`, then summarises the new picks and last week's results.
- **Catch-up is built in:** whenever any tool is called, the server checks for missed closed weeks and offers `run_weekly`. A missed window means the late week is recorded as `late_backfill`, never written as a normal pre-open record, so the forward-test evidence stays honest.
- **Optional:** the README shows how to add a plain OS schedule (launchd on Mac, Task Scheduler on Windows) that runs `uv run nse-screener-mcp --weekly` with no Claude involved.

### 4.5 Keeping the plugin and this repo in step

The engine is developed here in `trading-agent`. A script `scripts/build_plugin.py` copies `engine/` (plus the `src/` modules it imports) into the plugin repo's `engine/`, pins dependencies, bumps the version and runs the plugin tests. The plugin repo is a build output — never edit it by hand. Releases are tagged so users get updates through the marketplace.

## 5. Phases

**Phase 0 — spike (1 day).** `engine/mcp_server.py` with `get_capabilities` and `run_screen` only. Load it with `claude --plugin-dir ./nse-screener-plugin`, run one golden prompt end to end, then upload the zip in Cowork and repeat. Confirm: `uv` start-up works on a clean Mac, `${CLAUDE_PLUGIN_ROOT}` expands, how long the first run takes. **Exit:** one golden prompt screened inside Claude Code and inside Cowork.

**Phase 1 — engine tools (2–3 days).** All of §4.2 over stdio, the local state folder, imports separated from the web app's SQLite, and per-tool tests (pytest) including: an invented key rejected and named; `save_screen` gives a numeric ID; records are immutable; `run_weekly` is idempotent and marks late weeks `late_backfill`.

**Phase 2 — skills (1–2 days).** The three skills plus references (capabilities summary generated from `conditions_payload()`, golden examples).

**Phase 3 — eval with Claude as the interpreter (1–2 days).** Run the 20 golden prompts through Claude Code headless with the plugin loaded (`claude -p --plugin-dir …`, or a `claude plugin eval` suite) and score the programs and screens against the golden answers with the existing scorers. **Pass bar:** at least as good as the current best local result (`results/interpreter-eval/gemma4_31b.json`, `results/compiler-eval/gemma4_31b.json`). Below that, add `compile_prompt` (§4.3) and re-run.

**Phase 4 — package and publish (1 day).** `scripts/build_plugin.py`, the plugin repo with `marketplace.json`, README (install, first data refresh, where data lives, uninstall, disclaimer). Test a fresh install on a clean Mac and on Windows, in Claude Code and in Cowork.

**Phase 5 — invited users (ongoing).** Share the repo with a few users and collect issues. Directory submission only after §8.

## 6. What stays, what goes

| Piece | Status |
|---|---|
| Python engine, v5 IR, forward-test record rules | **Stays** — this is the product |
| New: `engine/mcp_server.py`, the skills, plugin repo, build script | **Added** |
| Next.js web app, Ollama path, local evals | **Stays for our own development**, not shipped in the plugin |
| Supabase auth, hosted server, Hugging Face plan | **Not needed** for this route |

## 7. Trade-offs to know up front

- **Desktop only.** Claude Code and Cowork on a computer. Browser and phone chats can't run the engine (see §9 if that's needed).
- **Users need a working local setup:** `uv` (Phase 0 decides whether we can rely on it), network access to the data sources, and disk for the cache.
- **Weekly runs depend on the user's computer being on** at the right time; catch-up and `late_backfill` cover misses honestly.
- **Usage is on the user's plan.** Keep tool output compact; long strategies with several fix-up rounds use more.
- **No central view.** We don't see users' screens or results, which is simpler and more private, but there's no shared leaderboard or "Explore" page unless we add one later.
- **Interpreter drift.** Claude's behaviour can change between releases; the schema and `check_program` keep programs valid, and the golden eval should be re-run each plugin release.

## 8. Before opening to outside users

- **SEBI:** a tool that hands outside users stock picks with SL / EP / confidence may still fall under the Research Analyst regulations, even if it runs on their computer. Get a securities lawyer's view before a public release or directory submission.
- **Data source terms:** each user fetches data for their own use, but check yfinance / Yahoo and NSE archive terms for automated use.
- **Disclaimer** in the README and in every `run_screen` result.

## 9. Optional later: browser and phone chats

If users need it in claude.ai on the web or mobile, the same plugin can also list a **remote** engine (an `http` entry in `.mcp.json` with a fixed URL), which Chat shows on the plugin's Connectors tab. That brings back a hosted server, sign-in and user data on our side, so it's deliberately out of scope for v1.

## 10. Decisions needed from Dharmin

1. Desktop-only launch (Claude Code + Cowork), with browser/phone chat out of scope (recommended)?
2. Can we require `uv` on users' machines, or must the plugin set up Python itself? (Phase 0 informs this.)
3. Weekly runs through a Claude scheduled task (recommended), an OS schedule, or both?
4. Launch to invited users first (recommended), public release after §8.
