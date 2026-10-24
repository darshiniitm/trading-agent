# Prompt-screener → production on Netlify — EDA + implementation plan

**Status:** plan v1.0, 25 Oct 2026 — for Claude Code to implement. **Nothing here is built yet.**
**Owner decision (Dharmin, 25 Oct 2026):** production goes on **Netlify**.
**Relationship to earlier plans:**
- `docs/production-deployment-plan.md` §7–§9 (one Docker VM, SQLite on its disk, engine spawned in the same container) is **superseded** by this plan. Netlify has no persistent disk and can't run Python, so that design doesn't carry over.
- `docs/production-llm-cloud-observability-plan.md` (Ollama Cloud + Grafana Cloud) **still applies**. This plan fills in its open decision **D2 (production host)** and adds the changes serverless needs (§7).
- `docs/production-llm-plan.md` model choice is already replaced by Ollama Cloud (22 Oct). Not touched here.

---

## 1. Summary — what Netlify changes

Netlify can host the **Next.js app** (pages, API routes, middleware). It can't host two things this app relies on today:

| Today (local, on the Mac) | Why it can't move to Netlify as is | Production answer |
|---|---|---|
| App database is **SQLite** (`frontend/apps/web/data/app.db`, `better-sqlite3`) | Netlify functions run on short-lived machines with no disk that lasts. Every cold start would get an empty database. | Move the app DB to **Supabase Postgres** (`screener_app` schema). This is the largest piece of work (§4). |
| Screening **engine** is a Python FastAPI process (`uvicorn engine.app:create_app`) that the web app **spawns as a child process** (`EngineSupervisor`) | Netlify Functions run JS/TS (and Go) only. Spawning a long-lived child process isn't possible. The engine also keeps ~220 MB of parquet data warm in memory and writes `results/` files. | Run the engine as a **separate always-on container** on a host with a persistent volume (§5). The Netlify app calls it over HTTPS with a shared secret. |
| Weekly catch-up job (`npm run jobs:catch-up`) runs by hand | Netlify scheduled functions stop after 30 s. | Scheduled function → **background function** (15 min), or cron on the engine host (§6). |
| Telemetry batches spans and flushes on a timer / on process exit | Serverless functions freeze after the response, so batched spans get lost | Flush at the end of every request (§7). |

Target shape:

```
Browser ──► Netlify (Next.js 14: pages + API routes as functions, middleware as edge function)
              │  ├─► Supabase Auth (Google / GitHub / email)
              │  ├─► Supabase Postgres  (screener_app.* app tables; observability.* run records)
              │  ├─► Ollama Cloud       (interpreter LLM, OLLAMA_API_KEY)
              │  └─► Grafana Cloud OTLP (traces/metrics/logs)
              └──HTTPS + ENGINE_TOKEN──► Engine container (FastAPI, Python 3.11, persistent volume:
                                          data_cache/, data_cache_literal/, results/)  ──► Yahoo/yfinance
```

---

## 2. EDA — what the codebase looks like today (checked 25 Oct 2026)

### 2.1 Web app — `frontend/` (npm workspaces)
- Monorepo root `frontend/package.json`, workspaces `apps/*` and `packages/*`. App = `apps/web`; shared package = `packages/spec` (imported as `"spec": "*"`).
- **Next.js 14.2.35**, React 18.3, App Router. `next.config.mjs`: `experimental.instrumentationHook: true`, `serverComponentsExternalPackages` = `pg` + the OpenTelemetry packages.
- Scripts: `dev`/`start` hard-code `-H localhost` (doesn't matter on Netlify; the adapter doesn't use `next start`).
- **36 API route handlers** under `app/api/**` + `app/auth/callback/route.ts`. Every one of them calls `db()` (SQLite).
- `middleware.ts`: Supabase SSR session refresh + auth gate for all pages/APIs except `/login`, `/signup`, `/forgot-password`, `/auth/callback`, `/api/health`, `/api/auth/logout`. Uses only `@supabase/ssr` and `next/server`, so it can run as a Netlify Edge Function.
- `instrumentation.ts` → `instrumentation.node.ts` runs at server start: (0) `initTelemetry()`, (1) `getSupervisor().ensureEngine()` **spawns uvicorn**, (2) with `LLM_PROVIDER=cloud` checks the model is in Ollama Cloud `/api/tags` and **throws** if it isn't.
- Native dependency: `better-sqlite3` (13.0.3, in `allowScripts`). It must not be in the production function bundle.

### 2.2 App database — SQLite
- `src/server/db/client.ts`: opens `data/app.db` (or `PS_DB_PATH`), sets WAL, runs migrations, seeds the owner user. **Synchronous** API.
- 12 SQLite migrations (`src/server/db/migrations/0001…0012`) → **26 tables**: `users, prompts, prompt_drafts, prompt_conditions, compilations, runs, run_results, run_provenance, run_condition_coverage, run_unevaluated, validations, jobs, entry_events, watchlists, watchlist_entries, symbols, symbol_fundamentals, symbol_metrics, user_defaults, user_benchmarks, user_view_prefs, signup_allowlist, auth_events, interpreter_edit, interpreter_example, kb_alias_proposal`.
- Size: **~188 `.prepare()` calls and 11 `.transaction()` blocks** across **33 server modules** + the 36 routes. `Database.Database` is passed down as a parameter (`withUser(raw, …)`, `ownsDraft(raw, …)`, `runCatchUp(raw, …)`, `uploadForDraft(db(), …)`).
- Current file is 2.4 MB, so the data move itself is small.

### 2.3 Supabase warehouse — `db/` (Python migrations)
- 10 migrations already applied by `python -m db.migrate`. Schemas: `ref, market, kb, fwd, prompt_details, ops, observability, screener_app`.
- `screener_app` already holds a **partial, differently named mirror** of the app tables: `users` (with `auth_user_id` FK to `auth.users`), `user_prompts` (renamed from `prompts` in 0008), `prompt_conditions`, `watchlists`, `watchlist_items`, `signup_allowlist`, `auth_events` (immutable trigger). That's about 7 of the 26 SQLite tables, and **the web app doesn't read any of them yet**.
- Telemetry already talks to Postgres: `src/server/telemetry/pgStore.ts` uses `pg` with **unnamed queries only** (it's already safe for the transaction pooler) and `TELEMETRY_DB_URL || SUPABASE_DB_URL`.
- `.env.example` notes that the direct host is IPv6-only and recommends the Session pooler (5432). On serverless, use the **Transaction pooler (6543)** instead (§4.4).

### 2.4 Engine — Python
- `requirements.txt`: pandas, numpy, scipy, statsmodels, pyarrow, yfinance, fastapi, uvicorn, psycopg, sqlalchemy, OTel. Python 3.11.
- On start (`lifespan`) it runs `watchdog.start_from_env()` (exits when `ENGINE_PARENT_PID` dies) and `WARM.start(_warm_literal)`, which loads the literal environment + per-stock bar indexes into memory. First requests wait on this warm-up.
- Data on disk (gitignored, **not in GitHub**): `data_cache/` **174 MB** (of which `ohlcv/` 132 MB) and `data_cache_literal/` **49 MB**.
- Writes to disk: `results/prompt_arms/registry.json` and forward records (`engine/arms.py`, `engine/forward_record.py`), `data_cache/views_daily/*.parquet` (`metrics_service.py`), plus the parquet caches refreshed from Yahoo.
- `src/storage` supports `DATA_BACKEND=file|postgres`. The default and current setting is `file`.
- **No authentication.** It listens on `127.0.0.1:8001` and trusts its caller. That's fine locally, but it must change before the engine is reachable from the internet.
- Market data comes from Yahoo/yfinance (`engine/quotes.py`, `fundamentals.py`, `resolution/ohlcv.py`, `src/data/adapter.py`).

### 2.5 LLM + observability (already planned for cloud)
- `src/server/llm/config.ts`: `LLM_PROVIDER=local|cloud`, `LLM_TIMEOUT_MS` default 8000 with per-task overrides (`LLM_TIMEOUT_MS_MODELREAD/_CRITIC/_CURATE`), `LLM_MAX_RETRIES=1`, then fallback models.
- Interpreter pipeline (`compiler/v5/interpret.ts`): pre-annotate → reader → grounder → slot resolver → verifier → critic (≤ 2 rounds) → dry run. It's rules-first: the 15 Oct dry run found 0 model calls on the 20 golden prompts and 2–3 calls on unfamiliar wording.
- `telemetry/bootstrap.ts` uses `BatchSpanProcessor` and flushes on `beforeExit`/signals. `pgStore.ts` flushes on a `setInterval`.

### 2.6 Repo state — blocker for any git-based deploy
- `git status` shows **523 uncommitted changes** (including deleted `engine/conditions/*` and modified `engine/app.py`/`env.py`). The last commit is `f50b9cc Merge engine branch`. Remote: `github.com/darshiniitm/trading-agent`.
- Netlify builds from the Git remote, so **what's on GitHub is what ships**. The working tree has to be committed and pushed (on a branch, tests green) before Phase 1.
- `.gitignore` excludes `.env`, `.env.local`, `data_cache*`, `results/*` (with a few exceptions). Good; these must stay out of the repo.

---

## 3. Netlify facts this plan relies on (checked 25 Oct 2026, verify again in Phase 0)

Source: https://docs.netlify.com/build/functions/configuration

| Limit | Value |
|---|---|
| Synchronous function execution | **60 s**, not configurable |
| Scheduled function execution | **30 s** |
| Background function execution | **15 min** (returns 202 immediately; request/response payload ≤ 256 KB) |
| Buffered response payload | 6 MB (streamed: 20 MB) |
| Function memory | 1024 MB default; 1–4 GB configurable only on credit-based Pro/Enterprise |

- Functions run JS/TS (and Go). **No Python runtime.**
- Next.js on Netlify uses the Netlify Next.js adapter (OpenNext-based), which is installed automatically. API routes and SSR become functions, and `middleware.ts` becomes an Edge Function. **Verify in Phase 0** that Next 14.2's `instrumentationHook` runs on cold start under the adapter. It's assumed below, not confirmed.
- Functions default to a US region. Pick the function region nearest to the Supabase project and the engine host (ideally Mumbai/ap-south-1) under Site settings → Functions (**verify** which regions your plan offers).

---

## 4. Phase 1 — App DB: SQLite → Supabase Postgres (largest piece, ~4–6 days)

Goal: the web app reads and writes `screener_app.*` in Supabase through `pg`, with **one schema shared by local and production**. Local dev points at a dev Supabase project (or the embedded `pgserver` used by Python tests). SQLite is removed from the request path.

### 4.1 Schema
1. Write `db/migrations/0011_screener_app_full.sql` (Python migration runner, re-runnable, checksum-locked like the others). It ports all 26 SQLite tables into `screener_app`.
   - **Reuse** the existing `screener_app.users`, `signup_allowlist`, `auth_events` (keep the immutable trigger and the `auth_user_id` FK).
   - **Reconcile names:** the code says `prompts` and `watchlist_entries`, but Supabase has `user_prompts` and `watchlist_items`. Pick one set and record the choice in the migration header. Recommendation: rename the Postgres tables to the code's names, because the code is the larger surface. That's a decision for Dharmin (§10 D4).
   - Type mapping: `INTEGER PRIMARY KEY` → `bigint generated always as identity` (keep numeric-only ids, per the 3 Oct decision), JSON text → `jsonb`, SQLite `TEXT` dates → `timestamptz`/`date`, booleans 0/1 → `boolean`. Check every `CHECK`/`UNIQUE`/FK carries over.
   - Keep the 12 Oct rule: **no eval/golden tables in the DB.**
2. Retire the TS-side `src/server/db/migrate.ts` for Postgres. There's one migration runner (Python `db/migrate.py`). The web app never runs DDL at request time.
3. Owner seed (`ensureOwnerUser`) becomes an idempotent migration or a one-off script keyed on `OWNER_EMAIL`, not something run on every `db()` call.

### 4.2 Data access layer
1. New `src/server/db/pg.ts`: a single `pg.Pool` per function instance (`max: 1–3`, `idleTimeoutMillis` short, `connectionTimeoutMillis` ~5 s) built from `APP_DB_URL`, stored on `globalThis` like the supervisor. Export `query(sql, params)` and `tx(fn)`.
2. Use **unnamed parameterised queries only** (no `name:` → no prepared statements), the same rule `pgStore.ts` already follows, because the Supabase transaction pooler rejects prepared statements.
3. Convert call sites from sync to async: `db().prepare(sql).get/all/run(...)` → `await query(...)`. The 11 `.transaction()` blocks become `await tx(async (c) => …)`.
   - Mechanical changes: `?` → `$1..$n`; `INSERT … RETURNING id` instead of `lastInsertRowid`; `INSERT OR IGNORE`/`ON CONFLICT` syntax; `datetime('now')` → `now()`; `json_extract` → `->>`; boolean comparisons.
   - Signature ripple: `withUser(raw, req, fn)`, `ownsDraft(raw, …)`, `runCatchUp(raw, …)`, `computeAllWatchlistMetrics(raw)`, `uploadForDraft(db(), …)` etc. stop taking a `Database` and use the pool. Do it module by module, not in one big edit.
4. Order of conversion (each step leaves tests green): auth/ownership (`src/server/auth/*`) → prompts/drafts/compiler persistence → runs/results/validations/jobs → watchlists + views → settings/benchmarks/explore → admin/allowlist → `scripts/run-weekly-jobs.ts`.
5. Remove `better-sqlite3` from `dependencies` once nothing imports it. Leave a dev-only SQLite→PG loader (4.3) under `scripts/` if it's still needed.

### 4.3 Data move (one-off)
- `scripts/migrate-sqlite-to-pg.ts`: reads `data/app.db` and inserts table by table in FK order inside one transaction, **keeping the original numeric ids** and then resetting each identity sequence to max(id)+1. It should be safe to re-run against an empty schema and refuse to run on a non-empty one.
- Verify: row counts per table match, and spot-check one prompt → draft → run → watchlist chain end to end.

### 4.4 Connection strings
- `APP_DB_URL` = Supabase **Transaction pooler** (`…pooler.supabase.com:6543`, `?sslmode=require`) for Netlify functions.
- Python warehouse and migrations keep using `SUPABASE_DB_URL` (Session pooler 5432).
- `TELEMETRY_DB_URL` can stay pointed at the same project, but use the 6543 string from Netlify.

### 4.5 Tests
- Point vitest DB tests at a throwaway Postgres (embedded `pg` via `pgserver`/`@electric-sql/pglite`, or a `docker postgres` in CI). Make that choice in the PR and keep it consistent with the Python `pgserver` tests.
- New test: the migration produces every table/column the code queries. This catches the `user_prompts`/`prompts` style drift.
- Full golden suite + paraphrase sets still pass after the switch, since screening behaviour must not change.

---

## 5. Phase 2 — Engine as its own always-on service (~1.5–2 days)

### 5.1 Host (decision D1)
The engine needs: Python 3.11, **≥ 2 GB RAM** (pandas panels for ~220 MB of parquet; measure the real RSS in Phase 0), a **persistent volume** (~1 GB to start), always-on (no scale-to-zero, because warm-up is slow), and outbound HTTPS to Yahoo. Recommended order:
1. **Fly.io, Mumbai (`bom`)**: 1 machine, attached volume, `auto_stop_machines = off`. Close to Indian users and Yahoo NSE data.
2. Google Cloud Run `asia-south1` with `min-instances=1` + a Filestore/GCS-FUSE mount (more moving parts for the volume).
3. Render / Railway with a disk (simple, but check which regions are available).

Any of these keeps the current `DATA_BACKEND=file` engine working unchanged. Moving engine data to Postgres (`DATA_BACKEND=postgres`) is **out of scope for v1** (§9).

### 5.2 Engine changes (small, all behind env flags so local is unchanged)
1. **Auth:** FastAPI dependency that requires `Authorization: Bearer $ENGINE_TOKEN` on every route except `/health`. It's a no-op when `ENGINE_TOKEN` is unset (local). The web client (`src/server/engine/client.ts`) adds the header when `ENGINE_TOKEN` is set, and so does `supervisor.ts`'s `/warmup/retry` call.
2. **Watchdog:** `watchdog.start_from_env()` is already a no-op without `ENGINE_PARENT_PID`. Confirm it stays off in the container.
3. **Paths:** make `data_cache/`, `data_cache_literal/`, `results/` resolve from one `ENGINE_DATA_DIR` (default = repo root, so local doesn't change). On the host, point it at the volume (`/data`). Hard-coded relative paths to fix include `engine/app.py:46` (`data_cache/index_lists`), `engine/arms.py` `REGISTRY_PATH`, `engine/forward_record.py` `OUT_DIR`, `engine/metrics_service.py` `CACHE_DIR` and the `src/data` adapter caches.
4. **Bind:** `uvicorn --factory engine.app:create_app --host 0.0.0.0 --port $PORT`. Host TLS terminates in front.
5. **`Dockerfile.engine`** (repo root): `python:3.11-slim`, `pip install -r requirements.txt`, copy `engine/ src/ config/ db/`. The image is stateless; all state lives on the volume.
6. **Seed the volume** once: copy the current `data_cache*/` and `results/prompt_arms/` from the Mac (rsync/`fly sftp`), so the first warm-up doesn't have to re-download five years of bars from Yahoo. Afterwards the engine's own refresh keeps it current.
7. Health check: `/health` (already exists, and reports `warm` state).

### 5.3 Web side
- `ENGINE_MANAGED=0` in Netlify. The supervisor must never try to spawn. Add a hard guard: when `process.env.NETLIFY` is set, `ensureEngine()` is a no-op even if the env flag is forgotten.
- `ENGINE_BASE_URL=https://<engine-host>`.
- The `/api/engine/status` heartbeat keeps working (it probes `/health`). The idle-stop timer is irrelevant because there's no child process; skip `setInterval` creation when unmanaged.
- Engine call timeouts: every `fetch` to the engine gets an `AbortSignal.timeout` below the function budget (§6.2).

---

## 6. Phase 3 — Netlify site + build config (~1 day)

### 6.1 `netlify.toml` (repo root)
```toml
[build]
  base    = "frontend"
  command = "npm ci && npm run build -w apps/web"
  publish = "apps/web/.next"

[build.environment]
  NODE_VERSION = "20"
  NEXT_TELEMETRY_DISABLED = "1"

[functions]
  node_bundler = "esbuild"
  # keep Node-only packages external, mirroring next.config serverComponentsExternalPackages
  external_node_modules = ["pg"]
```
- Netlify UI: Base directory `frontend`, Package directory `apps/web` (monorepo). Confirm in Phase 0 that the adapter detects the workspace and bundles `packages/spec`.
- Branch deploys: `main` → production; every PR gets a Deploy Preview. Previews must use the **staging** Supabase project and a staging engine (or the same engine with a separate token). They must never touch production data.

### 6.2 Request-time budget (60 s sync limit)
Worst-case interpreter path today: up to ~3 model calls × (8 s timeout + 1 retry) + fallback model + critic rounds + engine `screen`/`feasibility`. That **can exceed 60 s** on unfamiliar wording when Ollama Cloud is slow.
1. **Measure first** (Phase 0): log p50/p95/max wall time for `POST /api/drafts/[id]/program`, `/program/screen`, `/program/feasibility`, `/confirm` over the golden + blind/fresh sets against Ollama Cloud and the hosted engine.
2. If p99 < 45 s, keep the routes synchronous and set a hard overall deadline of 50 s inside the compiler (`AbortController` threaded through `callModel`) that returns the best draft so far with a "partial" flag.
3. If p99 ≥ 45 s, move compile and screen to a **background function** + polling:
   - `POST /api/drafts/[id]/program` writes a `jobs` row (status `queued`), invokes `/.netlify/functions/compile-background` with `{jobId}` (≤ 256 KB payload), and returns `202 {jobId}`.
   - The background function runs the existing compiler and writes the result to Postgres.
   - The UI polls `GET /api/jobs/[id]` (the `jobs` table already exists in SQLite, so port it).
   - Constraint (17 Oct): **no retry loops or voting** are introduced. The background path runs the same single pipeline.

### 6.3 Startup work under serverless
- `instrumentation.node.ts` runs once per cold start, not once per server:
  - Skip `ensureEngine()` when unmanaged (5.3).
  - The Ollama Cloud `/api/tags` check must **not throw** (a throw would fail the cold start, so every request 500s). Log + emit a metric instead, and expose it on `/api/health`.
  - `warmModel()` is local-only. It's already skipped for cloud.

### 6.4 Environment variables (Netlify → Site configuration → Environment variables; mark secrets "secret", scope Functions)
| Variable | Value / note |
|---|---|
| `APP_ENV` | `production` |
| `APP_URL` | `https://<site>.netlify.app` or the custom domain |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **production** Supabase project |
| `SUPABASE_SERVICE_ROLE_KEY` | only if the owner-invite page is turned on; server-only |
| `OWNER_EMAIL`, `NEXT_PUBLIC_CAPTCHA_SITE_KEY` | as today |
| `APP_DB_URL` | Supabase transaction pooler 6543 (§4.4) |
| `TELEMETRY_DB_URL` | same project, 6543 |
| `LLM_PROVIDER=cloud`, `OLLAMA_HOST=https://ollama.com`, `OLLAMA_API_KEY`, `OLLAMA_MODEL`, `OLLAMA_FALLBACK_MODELS`, `LLM_TIMEOUT_MS*`, `LLM_MAX_RETRIES` | from the Ollama Cloud plan |
| `ENGINE_MANAGED=0`, `ENGINE_BASE_URL`, `ENGINE_TOKEN` | §5 |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`, `TELEMETRY_HASH_SALT` | Grafana Cloud |
| **Not needed in prod** | `HF_TOKEN`, `OPENROUTER_API_KEY`, `GRAFANA_API_KEY`/`GRAFANA_SA_TOKEN`/`GRAFANA_URL` (provisioning tools, run from the Mac), `PS_DB_PATH`, `SUPABASE_DB_URL` (Python only) |

- Commit a `frontend/apps/web/.env.production.example` with **names only**.
- The current `.env` files contain live keys. Before connecting the repo, double-check none are tracked (`git ls-files | grep -i env`), and **rotate any key that was ever pasted into chat or committed.**

### 6.5 Auth (Supabase) for the new origin
- Client code builds redirects from `window.location.origin`, and `auth/callback` uses `APP_URL ?? url.origin`. **No code change needed.**
- Production Supabase project → Authentication → URL configuration: Site URL = `APP_URL`; Redirect URLs = `https://<domain>/auth/callback` **and** the Deploy Preview pattern `https://deploy-preview-*--<site>.netlify.app/auth/callback` (staging project only).
- Google and GitHub OAuth apps call back to **Supabase's** `https://<project>.supabase.co/auth/v1/callback`, not the Netlify URL. They only need changing if production uses a new Supabase project (recommended, D2).
- Middleware runs as an Edge Function. Confirm the cookie refresh (`setAll`) works on Netlify Edge in the Phase 0 preview.

---

## 7. Phase 4 — Serverless fixes for telemetry (~½ day)

- Spans, metrics, logs and `pgStore` rows are buffered. When the function freezes after the response, the buffers are lost or sent late.
- Add `flushTelemetry()` (calls `forceFlush()` on tracer/meter/logger providers + `store.flush()`), and call it **after the response** using Netlify's `context.waitUntil` when the adapter exposes it (verify). If it doesn't, call it before returning in the route wrapper used by `withUser`/`inRun`. Cap it at ~1.5 s so telemetry never fails a request.
- When `process.env.NETLIFY` is set, don't start the `pgStore` `setInterval` and don't rely on `beforeExit`.
- Add `service.instance.id` = function instance id / `AWS_LAMBDA_LOG_STREAM_NAME` if present, so Grafana can tell cold starts apart.
- Engine (long-lived) keeps its current batch behaviour.

---

## 8. Phase 5 — Weekly jobs (~½ day)

`scripts/run-weekly-jobs.ts` (catch-up + grade for every confirmed prompt, then watchlist view metrics) must keep the **pre-open recording rule**: a job that misses its window logs and does nothing rather than recording late.

Recommendation: run it on the **engine host** as a cron (Fly scheduled machine / Cloud Scheduler → container). It talks to the engine locally and has no 15-min ceiling. It needs `APP_DB_URL` and the OTel envs.

Netlify-only alternative: `netlify/functions/weekly-trigger.mts` (scheduled, `config.schedule` in UTC; Monday pre-open IST = Sunday/Monday UTC offset, so compute it explicitly) that only enqueues and calls a `weekly-background` function (15 min). Choose this only if Phase 0 shows a full catch-up finishes well under 15 min.

The Python `scripts/weekly_selection_run.sh` (forward test, Literal/T1 arms) is not part of the web app. Leave it on the Mac unless Dharmin wants it in production (D5).

---

## 9. Out of scope for v1 (tracked, not blocking)
- Engine data in Postgres (`DATA_BACKEND=postgres`) instead of parquet on a volume.
- Multiple engine replicas / horizontal scale (needs the above first).
- A queue service (Upstash/QStash, Supabase Queues) beyond the background-function pattern.
- Licensed NSE market data in place of Yahoo/yfinance. Yahoo can throttle or block datacenter IPs, so watch the engine's fetch error rate after go-live. Licensed data is **required before outside users**.
- SEBI Research Analyst review before outside users receive SL/EP/confidence picks.
- Custom domain + Netlify analytics.

---

## 10. Decisions needed from Dharmin
1. **D1 Engine host:** Fly.io Mumbai with a volume (recommended) / Cloud Run asia-south1 / Render-Railway.
2. **D2 Supabase:** separate production project (recommended; local + Deploy Previews keep the current one as staging) or share the current project.
3. **D3 Long requests:** decide after the Phase 0 timing run. Keep sync with a 50 s deadline, or move compile/screen to background functions + polling.
4. **D4 Table names:** rename the Postgres `screener_app.user_prompts`/`watchlist_items` to the code's `prompts`/`watchlist_entries` (recommended), or change the code to the Postgres names.
5. **D5 Weekly jobs:** run on the engine host cron (recommended) or on Netlify scheduled + background functions; and whether the Python forward-test run also moves to production.
6. **D6 Netlify plan:** Free vs Pro. Pro adds function-region choice and more build minutes/bandwidth. Memory above 1 GB isn't needed for the web functions.
7. **D7 Who uses it at launch:** only you/team, or outside users. This drives rate limits per user, the data-licensing item and the SEBI review.

---

## 11. Phase 0 — do first (~½ day, before Phase 1)
1. Commit and push the 523 pending changes on a branch, get tests green, merge to `main` (§2.6).
2. Create the Netlify site from `github.com/darshiniitm/trading-agent` with the §6.1 settings. Let it build a **Deploy Preview** as is. Expect runtime errors (no SQLite, no engine). The goal is only to confirm the monorepo build, the `spec` workspace package, `instrumentationHook`, and middleware-as-edge on Next 14.2.
3. Measure engine RSS after warm-up on the Mac (`ps -o rss` on the uvicorn pid) to size the host.
4. Timing run (§6.2 step 1) against Ollama Cloud → decides D3.
5. Capture the answers to D1–D7.

## 12. Go-live checklist
- [ ] `0011_screener_app_full.sql` applied to the production Supabase; SQLite data moved; row counts match.
- [ ] Engine container healthy, `warm.state = ready`, rejects requests without `ENGINE_TOKEN`.
- [ ] Netlify production deploy green; `/api/health` reports DB ✓, engine ✓, Ollama Cloud model ✓.
- [ ] Sign in with Google, GitHub and email on the production URL; sign-out works; signed-out API calls get 401.
- [ ] Submit 3 golden prompts + 2 blind paraphrases: drafts compile, screens run, watchlist renders, all five views (Price, Financials, Performance, Risk, Technicals) load.
- [ ] One full run appears in Grafana Cloud as one trace (web → engine) and in `observability.*` tables.
- [ ] Weekly job fired once in dry-run mode and wrote nothing it shouldn't.
- [ ] Supabase daily backups on (or a `pg_dump` cron for the free tier) + engine volume snapshot; restore tested once.
- [ ] `docs/runbook-production.md`: deploy (merge to `main`), roll back (Netlify "Publish deploy" on the previous deploy; engine: previous image), rotate `OLLAMA_API_KEY`/`ENGINE_TOKEN`, read logs (Netlify function logs, engine host logs, Grafana), restore DB.

## 13. Estimate
Phase 0 ½ d · Phase 1 4–6 d · Phase 2 1.5–2 d · Phase 3 1 d (+1–2 d if D3 = background) · Phase 4 ½ d · Phase 5 ½ d · go-live ½ d → **about 8–11 working days**. Phase 1 is the critical path and is worth doing even if the host later changes, because it removes the single-disk dependency.
