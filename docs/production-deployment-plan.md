# Local + Production versions — implementation plan

> **Superseded in part (15 Oct 2026):** §3–§6 (Hugging Face provider) are replaced by `docs/production-llm-plan.md` (Gemma 4 on the Gemini API, 26B primary → 31B on rate limit). §7–§11 still apply.


**Status:** plan v1.0, 15 Oct 2026 — for Claude Code to implement. Nothing here is built yet.
**Owner decision (Dharmin, 15 Oct 2026):** keep the existing local version on Ollama; add a production version that calls `google/gemma-4-31B-it` through Hugging Face.

---

## 1. The one idea that shapes everything

"Local" and "production" are **two configurations of one codebase**, not two copies of the code. Same `main` branch, same tests, same prompts; an environment profile decides which model backend, database file, Supabase project and engine wiring are used. Forking the code would mean every fix to the compiler, engine or watchlist views has to be made twice and the two would drift.

| | Local (existing) | Production (new) |
|---|---|---|
| `APP_ENV` | `local` | `production` |
| LLM backend | Ollama on the Mac, `gemma4:31b` | Hugging Face Inference Providers, `google/gemma-4-31B-it` |
| Where it runs | `npm run dev` on the Mac | one Linux server (Docker), always on |
| App DB | `frontend/apps/web/data/app.db` (SQLite) | same SQLite schema, on the server's persistent disk, backed up nightly |
| Engine (FastAPI) | spawned by the web app (`EngineSupervisor`) | same — spawned inside the same container, never idle-stopped |
| Supabase | current project | a **separate** production project (own users, own OAuth redirects) |
| Weekly jobs | run by hand / `scripts/weekly_selection_run.sh` | server cron |

---

## 2. What exists today (read before changing anything)

- **Single model seam:** `frontend/apps/web/src/server/compiler/callModel.ts`. Every model call (`fallback`, `modelRead`, `reader`, `critic`, `curate`) goes through `callClaude(system, user, format, opts)` → `callOllama(...)`. Callers: `src/server/compiler/v5/{fallback,critic,reader,modelRead,curate}.ts`. **Nothing outside this file talks to Ollama**, so the switch is contained.
- **Ollama-specific behaviour the HF path must reproduce:**
  1. `format` = a JSON Schema (from `zod-to-json-schema`, e.g. `CLAUSE_JSON_SCHEMA` in `v5/fallback.ts`) → constrained decoding, so keys can't be missing.
  2. Per-task thinking on/off and token budgets in `TASK_PROFILES` (`think`, `num_predict`), overridable by `OLLAMA_THINK_<TASK>=0|1`.
  3. `temperature: 0`.
  4. Streaming (only to dodge Node's 300 s header timeout on a slow local model).
  5. `warmModel()` called from `instrumentation.node.ts` at boot (`OLLAMA_WARM=0` disables).
- **Evals to gate the switch:** `scripts/eval-interpreter-model.ts`, `scripts/eval-compiler-model.ts` (both take Ollama model names and use `ollamaFor(model)`), the 20-prompt golden set in `tests/golden/`, and previous Ollama baselines in `results/interpreter-eval/gemma4_31b.json`, `results/compiler-eval/gemma4_31b.json`.
- **Not serverless-friendly by design:** the app DB is `better-sqlite3` on local disk, the engine is a child process (`src/server/engine/supervisor.ts`) bound to `127.0.0.1:8001`, and the engine reads parquet caches in `data_cache/` and `data_cache_literal/`. This rules out Vercel/Netlify functions for v1 and points to a single always-on server with a persistent disk (§7).

---

## 3. Hugging Face facts this plan relies on (checked 15 Oct 2026)

- Model: `google/gemma-4-31B-it`, **Apache 2.0** — commercial use is fine.
- Endpoint: OpenAI-compatible router, `https://router.huggingface.co/v1/chat/completions`, auth `Authorization: Bearer $HF_TOKEN`. Provider pinned with a model suffix, e.g. `google/gemma-4-31B-it:deepinfra` (verify the suffix form in Phase 0).
- Providers serving it (HF "Compare providers" page):

| Provider | $/1M in | $/1M out | Context | Throughput | Structured output | Tool calling |
|---|---|---|---|---|---|---|
| deepinfra (cheapest) | 0.13 | 0.38 | 262K | ~45 t/s | yes | yes |
| cerebras (fastest) | 0.99 | 1.49 | 131K | ~816 t/s | yes | yes |
| together | 0.39 | 0.97 | 262K | ~9 t/s | yes | yes |
| novita | 0.14 | 0.40 | 262K | ~3 t/s | yes | no |

- Structured output uses OpenAI's shape: `response_format: { type: "json_schema", json_schema: { name, schema, strict } }`. HF warns support varies by model × provider × schema, and recommends **pinning a provider** rather than `auto`.
- Thinking: Gemma 4 turns thinking on with a `<|think|>` token at the start of the system prompt; with thinking off, 31B still emits an empty `<|channel>thought\n<channel|>` block. Providers may instead expose it as `chat_template_kwargs.enable_thinking` and/or return reasoning in a separate `reasoning_content` field. **Which mechanism works per provider is unknown → Phase 0 probes it.**
- Cost sanity check: our largest prompt is ~2k tokens. A full compile of one user prompt at ~10 calls ≈ 20k in + 15k out ≈ **under ₹1 on deepinfra**, ~₹3 on cerebras.

---

## 4. Phase 0 — HF account + capability probe (½ day, do first)

1. Dharmin: create the HF account/org for billing, add a payment method, set a **monthly spend limit**, create a fine-grained token with "Make calls to Inference Providers" only. Store as `HF_TOKEN` (never `NEXT_PUBLIC_*`, never committed).
2. Claude Code: `frontend/apps/web/scripts/hf-probe.ts`, run per provider in {deepinfra, cerebras, together}:
   - plain chat round-trip;
   - `response_format` with the real `CLAUSE_JSON_SCHEMA` (strict true, then false) — does the output parse and validate?
   - thinking **off** and **on** via each mechanism (system-prompt token, `chat_template_kwargs`, `reasoning_effort`) — does output length/latency change, and where does the reasoning text come back (inline tags, `reasoning_content`, nowhere)?
   - `temperature: 0` honoured? `max_tokens` honoured?
3. Write the results table to `docs/hf-probe-results.md`. **Exit gate:** at least one provider passes structured output with our schemas and has a working thinking toggle. If none does, stop and report — the fallback is a dedicated HF Inference Endpoint running vLLM, where we control the chat template and structured output (§10).

---

## 5. Phase 1 — provider switch in the model seam (1–2 days)

### 5.1 Config (`frontend/apps/web/src/server/config/llm.ts`, new)

```
APP_ENV            local | production          (default local)
LLM_PROVIDER       ollama | hf                 (default: ollama when local, hf when production)
# Ollama — unchanged names, so the local setup keeps working untouched
OLLAMA_BASE_URL, OLLAMA_MODEL, OLLAMA_COMPILER_MODEL, OLLAMA_THINK_<TASK>, OLLAMA_KEEP_ALIVE, OLLAMA_NUM_CTX, OLLAMA_WARM
# Hugging Face
HF_TOKEN                                       (required when LLM_PROVIDER=hf)
HF_BASE_URL        default https://router.huggingface.co/v1
HF_MODEL           default google/gemma-4-31B-it
HF_PROVIDERS       ordered list, default "deepinfra,together"   (first = primary, rest = failover)
HF_TIMEOUT_MS      default 120000
HF_THINK_<TASK>    0|1 override, same semantics as OLLAMA_THINK_<TASK>
```

Fail fast at boot: `APP_ENV=production` with `LLM_PROVIDER=ollama`, or `LLM_PROVIDER=hf` without `HF_TOKEN`, throws with a clear message. Log the resolved provider/model once at start (never the token).

### 5.2 Code

- Keep `callOllama` exactly as is.
- Add `callHF(system, user, format?, fetchFn?, model?, opts?)` in a new `src/server/compiler/callHF.ts`:
  - `POST {HF_BASE_URL}/chat/completions`, `model: "<HF_MODEL>:<provider>"`, `temperature: 0`, `max_tokens: profile.num_predict` (+ headroom if thinking returns inline), `messages: [system, user]`.
  - `format` given → `response_format: { type: "json_schema", json_schema: { name: "output", schema: format, strict: <per Phase 0> } }`; no `format` → `{ type: "json_object" }` (mirrors Ollama's `"json"` mode).
  - Thinking per `TASK_PROFILES` via the mechanism Phase 0 found working for that provider.
  - **Strip any thinking text** before returning (`<|channel>thought…<channel|>` blocks; ignore `reasoning_content`). Callers must receive only the answer, exactly as today.
  - Non-streaming is fine (no local 300 s cold start), with `AbortSignal.timeout(HF_TIMEOUT_MS)`.
  - Retries: 429 / 5xx / timeout → up to 2 retries with jittered backoff on the same provider, then move to the next in `HF_PROVIDERS`. 4xx other than 429 → throw immediately (it's our bug).
  - Return the same error style as `callOllama` (`"HF compiler request failed (<status>, <provider>): …"`).
- Make `TASK_PROFILES` provider-neutral (move to `src/server/compiler/profiles.ts`); `profileFor` reads `HF_THINK_<TASK>` or `OLLAMA_THINK_<TASK>` depending on provider.
- `callClaude` (keep the name — tests and callers inject it) becomes a dispatcher: `LLM_PROVIDER === "hf" ? callHF(...) : callOllama(...)`. Add `export const callModel = callClaude` as the new preferred name; don't rename callers in this change.
- Add `modelFor(spec)` next to `ollamaFor`: `"ollama:gemma4:31b"` or `"hf:google/gemma-4-31B-it:deepinfra"`. Update `eval-interpreter-model.ts`, `eval-compiler-model.ts`, `golden-compile.ts`, `paraphrase-eval.ts` to accept either form (a bare name keeps meaning Ollama).
- `warmModel()`: no-op returning `true` when provider is `hf`.
- Per-call telemetry (both providers): task, provider, model, input/output tokens (HF returns `usage`), latency, retry count → append to the existing prompt-details store alongside each agent's output (the 12 Oct decision: prompt ID, prompt, final answer, each agent's output). This is how cost and latency are watched in production.

### 5.3 Tests (vitest, mirror `tests/callModel.test.ts`)

- `callHF` with an injected `fetch`: request body shape (schema → `response_format`, thinking flag, temperature, max_tokens); thinking-block stripping; retry then failover order; no retry on 400; timeout path.
- Dispatcher picks Ollama/HF from env; boot validation throws on the two bad combos.
- Existing tests stay green unchanged with `LLM_PROVIDER` unset (local default = Ollama).

---

## 6. Phase 2 — quality gate before production uses it (½–1 day)

Same prompts, same scorers, two backends:

```
npx tsx scripts/eval-interpreter-model.ts ollama:gemma4:31b hf:google/gemma-4-31B-it:deepinfra hf:google/gemma-4-31B-it:cerebras
npx tsx scripts/eval-compiler-model.ts    (same three)
+ the 20 golden strategy prompts (tests/golden) end-to-end through compile → screen
```

- **Pass bar:** HF pass rate ≥ the Ollama `gemma4:31b` baseline on every suite, and no golden prompt that passes on Ollama fails on HF. Differences are expected (Ollama's build is quantized; providers usually serve BF16) — any regression gets a per-case diff in `docs/hf-eval-parity.md` and a decision from Dharmin.
- Re-check the per-task thinking profile on HF (the 27 s vs 96 s reader A/B was local hardware; on cerebras thinking may be cheap enough to turn on everywhere).
- Choose the primary provider on the evidence: deepinfra if quality ties (cheapest), cerebras if latency matters for the UX.
- Optional, same harness: `hf:google/gemma-4-26B-A4B-it:<provider>` (MoE, ~4B active — faster/cheaper). Only adopt if it clears the same bar.

---

## 7. Phase 3 — package the production build (1–2 days)

One Docker image, because the web app, engine and SQLite file must share a disk:

- `Dockerfile` (repo root): Node 20 + Python 3.11; `pip install -r requirements.txt`; `npm ci && npm run build` in `frontend/`; entrypoint `next start -H 0.0.0.0 -p 3000` (today's `start` script hard-codes `-H localhost`, which is unreachable inside a container — make host/port env-driven, keep localhost as the local default).
- Engine: keep `ENGINE_MANAGED=1` (the supervisor spawns `uvicorn` inside the container); set `ENGINE_IDLE_MINUTES` very high or add `ENGINE_IDLE_STOP=0` so production never idle-stops it. `ENGINE_DIR=/app`.
- Persistent volume `/data`: `PS_DB_PATH=/data/app.db`, data caches (`data_cache/`, `data_cache_literal/`) and `results/` symlinked or configured onto `/data`. Nothing stateful in the image.
- `docker-compose.prod.yml`: `app` service + `caddy` (automatic HTTPS for the domain). Health check hits the app's existing engine status route.
- Weekly jobs: host cron runs `docker compose exec app npm run jobs:catch-up -w apps/web` (and the Python `scripts/weekly_selection_run.sh` steps if they're to run in prod). Times in IST, configurable; must keep the pre-open recording rule — a job that misses its window logs and does nothing rather than recording late.
- Backups: nightly `sqlite3 /data/app.db ".backup ..."` → off-box storage (Supabase Storage or S3), keep 30 days. Test a restore once.
- `.env.production.example` committed (names only); real values only on the server.

---

## 8. Phase 4 — production environment (½ day, mostly Dharmin)

1. **Server:** one VM in India — AWS EC2/Lightsail `ap-south-1` (Mumbai) or DigitalOcean `BLR1`; 2 vCPU / 4–8 GB RAM / 40 GB disk is ample (no GPU — the model runs at HF). Docker + compose installed.
2. **Domain + HTTPS:** point a subdomain at the VM; Caddy issues the certificate.
3. **Supabase production project:** new project; enable Google, GitHub and email auth; add `https://<domain>/auth/callback` to Supabase redirect URLs and to the Google/GitHub OAuth apps. Set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `OWNER_EMAIL`, captcha key for prod.
4. **Secrets on the server:** `HF_TOKEN`, Supabase keys, `APP_ENV=production`, `LLM_PROVIDER=hf`, `HF_PROVIDERS` from Phase 2.
5. **Cost guards:** HF spend limit (Phase 0) + an app-side per-user limit on prompt submissions per day.

---

## 9. Phase 5 — go-live checklist and runbook

- [ ] Phase 2 parity report signed off.
- [ ] Smoke test on the prod URL: sign in with each of Google / GitHub / email; submit one golden prompt; watchlist renders; watchlist views (Price, Financials, Performance, Risk, Technicals) load.
- [ ] Cron fired once in a dry-run mode and wrote nothing it shouldn't.
- [ ] Backup + restore tested.
- [ ] `docs/runbook-production.md`: how to deploy (`git pull && docker compose -f docker-compose.prod.yml up -d --build`), roll back (previous image tag), rotate `HF_TOKEN`, switch primary provider (edit `HF_PROVIDERS`, restart), read logs, restore DB.

**How the agent runs once live:** user submits a prompt on the dashboard → Next.js API route runs the v5 compiler; each model step (`reader`, `modelRead`, `fallback`, `critic`) is a call to HF instead of the Mac → the compiled conditions go to the engine in the same container → watchlist written to `/data/app.db` and shown. Weekly, cron runs the catch-up/grade jobs for every confirmed prompt with no one at the keyboard. Locally nothing changes: `npm run dev` with no new env vars still uses Ollama.

---

## 10. Out of scope for v1 (tracked, not blocking)

- Moving the app DB from SQLite to Supabase Postgres (the 12 Oct warehouse plan) — needed before running more than one app server, not before launch.
- A job queue for compiles (worthwhile once concurrent users make in-request compiles slow).
- Dedicated HF Inference Endpoint (fixed hourly GPU) — only if per-token cost or data-residency needs it.
- Licensed NSE market data replacing yfinance/Yahoo — required before opening to outside users.
- SEBI Research Analyst applicability if outside users receive SL/EP/confidence picks — legal review before a public launch.

## 11. Decisions needed from Dharmin

1. Hosting: single VM in Mumbai (recommended) vs a managed container host with a volume (Render/Railway/Fly).
2. Separate Supabase project for production (recommended) vs sharing the current one.
3. Who uses production at launch: just you/your team, or outside users? (Drives rate limits, data licensing and the SEBI check.)
4. Primary HF provider — decided by Phase 2 evidence; default deepinfra.
