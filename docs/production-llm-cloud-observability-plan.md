# Prompt-Screener → Production: Ollama Cloud + Grafana Observability

**Status:** Part A (Phases 1–2) implemented 22 Oct 2026. Part B (Phases 3–4) implemented 23 Oct 2026 and retargeted to **Grafana Cloud** the same day; **tested against fakes only — never run against a real stack**. Production rollout (Phases 5–6) not started.
**Supersedes:** the 15 Oct production choice of Gemma 4 via Google AI Studio (`docs/production-llm-plan.md`). Local keeps local Ollama; production moves to Ollama Cloud (`gemma4:31b`, same model the interpreter was tuned on).
**Scope:** Laya AI is out; the interpreter is Gemma-only. The interpreter is TypeScript (`frontend/apps/web/src/server/compiler/`); the Python `engine/` makes no LLM calls.

The full original plan text (Parts A–C, open decisions D1–D5) is the 22 Oct 2026 review draft; only deviations and results are recorded below.

## Part A — implementation record

| Plan item | Where | Notes |
|---|---|---|
| A1 config & secrets | `src/server/llm/config.ts`, `.env.example` | `LLM_PROVIDER=local\|cloud`, `OLLAMA_HOST`, `OLLAMA_API_KEY`, `OLLAMA_MODEL`, `OLLAMA_FALLBACK_MODELS`, `LLM_TIMEOUT_MS`, `LLM_MAX_RETRIES`. Config is read per call. Key attached only for `cloud`. `.env` was already gitignored. |
| A2 one client | `src/server/llm/client.ts`; `callModel.ts` is a thin seam (public API unchanged) | Cloud: Bearer auth, hard timeout, one jittered retry on 429/5xx/timeout/network, ordered fallback chain, `stream:false`, one repair attempt, key redaction. **Local behaviour is unchanged** (streamed, no timeout/retry/fallback). Evals that pin a model (`ollamaFor`) bypass the fallback chain. |
| A2.3 startup check | `checkModelAvailable()` + `instrumentation.node.ts` | `LLM_PROVIDER=cloud` fails server start if the model is not in `/api/tags`. Missing fallback models only warn. |
| A2.4 telemetry | `src/server/llm/telemetry.ts` | Interface + no-op default (`setLlmTelemetry`). Events carry model, provider, status (`ok/429/5xx/timeout/bad_json/network/auth/client_error`), latency, attempt, and Ollama's `total_duration/load_duration/prompt_eval_count/eval_count/eval_duration`. Part B installs the real sink. |
| A4 cutover gate | `frontend/apps/web/scripts/eval-llm-parity.ts` → `results/llm-parity/{local,cloud,gate}.json` | Uses the interpreter golden cases that need the model (6). The 20 rules-only golden prompts make 0 model calls (see `production-llm-plan.md` §1.1). |
| Tests | `tests/llm/client.test.ts` (25) | Full web suite 712+ green. |

### Findings that change the plan (22 Oct 2026)

1. **Ollama Cloud does not enforce `format` JSON schemas for `gemma4:31b`** (local does). Verified with a strict single-value-enum schema on `/api/chat` (think on/off, stream on/off) and on the OpenAI-compatible `/v1/chat/completions` (`json_schema` and `json_object`): replies ignore the schema and arrive wrapped in a ```json fence. This invalidates plan §0's "JSON schemas carry over unchanged": the first parity run scored **0/3 on cloud vs 3/3 local**. Fix in the client (cloud only): the schema is appended to the system prompt as an output contract, markdown fences are unwrapped, a missing required top-level key triggers the single repair. After the fix cloud scored 6/6. Callers still deep-validate with zod.
2. **`LLM_TIMEOUT_MS=8000` is borderline for thinking tasks.** Before the schema contract, 7 of 13 calls timed out (and each timeout was retried, doubling wasted GPU time). With the contract, a 6-case run had zero timeouts at 8000 ms. Use `LLM_TIMEOUT_MS_MODELREAD` / `_CRITIC` / `_CURATE` if timeouts show up in Part B's dashboards.
3. **Cloud is ~9× faster than local** on these cases (p95 ≈ 5.8 s vs 50.5 s).

### A4 gate status — NOT YET PASSED (latency)

| Check | Result |
|---|---|
| Cloud pass-rate ≥ local | **pass** — 6/6 vs 6/6 |
| Zero unparseable JSON | **pass** — 0 `bad_json` |
| p95 end-to-end ≤ 5 s | **fail (narrow)** — 5.8 s (run 3), 8.8 s (run 2); n=6 so p95 is the max. p50 ≈ 4.2 s. A model-using prompt makes ≥2 sequential thinking calls (reader + critic). |

Not run yet: latency measured from Bengaluru under realistic volume, and a larger sample. Decision for Dharmin: re-measure with more cases / accept the budget for model-using prompts only (most prompts make 0 calls) / turn thinking off for `critic`. The gate is unchanged until then.

### Operating notes
- Run the gate: `cd frontend/apps/web && OLLAMA_API_KEY=… OLLAMA_MODEL=gemma4:31b npx tsx scripts/eval-llm-parity.ts` (`PARITY_PROVIDERS=cloud`, `PARITY_LIMIT=n` for smoke runs).
- Fallback models (D1) must pass their own golden run before being added to `OLLAMA_FALLBACK_MODELS`.
- The `OLLAMA_API_KEY` in `.env` was used for these runs; rotate if it was ever pasted in chat/logs.

## Part B — implementation record (23 Oct 2026)

Decisions (Dharmin, 23 Oct 2026): run records in **Supabase Postgres**; **Grafana Cloud only** (the local Docker/Alloy/Pushgateway stack built first was removed; Grafana reads Supabase through the read-only `grafana_ro` role); no production host (D2 open); alert contact point is an **env-driven placeholder webhook** (D3 open); **raw prompt text is stored** (secrets/emails redacted, user ids HMAC-hashed); a **run = the draft lifecycle** compile → screen → confirm (one trace).

| Plan item | Where |
|---|---|
| `@task` / `@agent` / `@tool` | TS: `frontend/apps/web/src/server/telemetry/{span,context,runtime,logger}.ts` (higher-order wrappers, OTel-context carried). Python: `src/telemetry/core.py` (decorators + `tool_span`). Both are pass-throughs unless configured. |
| One trace per prompt | `telemetry/run.ts`: trace id derived from the draft id; `prompt.compile/screen/confirm` are children of a synthetic remote parent; `prompt.run` is emitted at confirm with the same ids (`idGenerator.ts` forces them). Jobs: `inJobRun` (own trace, `kind=weekly_job`). |
| LLM events | `telemetry/llmSink.ts` bridges Part A's `LlmTelemetry` (spans, metrics, `tool_calls` rows `tool_name='llm.chat'`); the sink holder in `llm/telemetry.ts` is now `globalThis`-backed. |
| Run tables | `db/migrations/0010_observability.sql` (schema `observability`: `runs`, `run_tasks`, `agent_calls`, `tool_calls`, read-only `grafana_ro`). Writers: `telemetry/pgStore.ts` (TS) and `src/telemetry/writer.py` (engine) — bounded, async, never fail a run. **Not applied to any database yet.** |
| Engine | `engine/app.py` (init + FastAPI + `x-run-id` binding), `engine/resolution/resolver.py` (`data.fetch` + `data_fetch_*` counters, bounded `symbol_bucket`), `engine/v5/run.py` (`screen.filter`), `engine/env.py`, `engine/resolution/ops.py`. TS `engine/client.ts:call()` injects `traceparent` + `x-run-id`. |
| Weekly jobs | `scripts/emit_job_metrics.py` (read-only over the record files; hooked non-fatally into `scripts/weekly_selection_run.sh`; gauges go over OTLP). `tests/track_*.py` untouched. |
| `golden_suite_accuracy` | sent over OTLP by `scripts/eval-llm-parity.ts` and `eval-interpreter-model.ts` via `telemetry/gauges.ts`. Grafana Cloud has no Pushgateway and a pushed series goes stale minutes after the process exits, so dashboards / alerts read these gauges with `last_over_time(…[30d])`. |
| Grafana Cloud | `observability/build.py` generates the 6 dashboards and defines the 10 alert rules; `python -m observability.cloud headers|sync` builds the OTLP auth header and (dry-run by default) uploads folder, Supabase datasource, dashboards, alert rules and a placeholder contact point through the Grafana API. App/engine/jobs send OTLP straight to the stack's gateway (`OTEL_EXPORTER_OTLP_ENDPOINT` + `_HEADERS`). |

### Deviations from the draft
- `screener_*` gauges use label `screener_job` (`job` is reserved by Prometheus).
- No Alloy / Docker / Pushgateway; redaction is in-process only. Retention is the Grafana Cloud plan's, not 30 d / 14 d.
- `prompt_run_duration_seconds` = per-request processing time by `stage`/`outcome`, not wall-clock since draft creation.
- Engine spans are `screen.filter` / `data.fetch`; TS-side engine calls are `engine.*` (no double counting).
- `forward_test` job = the T1 shadow record; a fourth job `threshold_experiment` is also tracked.
- Product-usage dashboard reads run records only; watchlist sizes / per-condition usage live in the app's SQLite, not Supabase.
- Alerts are Grafana-managed rules created via the provisioning API (not Alertmanager); the cloud-budget rule reads `LLM_WEEKLY_GPU_SECONDS_BUDGET` at sync time (huge default = quiet until measured); "Weekly run missed" also alerts on no data.

### Verified vs not verified
- **Verified (automated):** TS wrappers/run/sink/store/bootstrap (`tests/telemetry/`) and Python core/writer/gauges/job-metrics (`tests/telemetry/`), including fake OTLP/HTTP collectors that receive traces, metrics and logs **with the `Authorization` header Grafana Cloud needs**; the writer and the TS-generated SQL against a real embedded Postgres with migration 0010 applied; engine wiring; `observability/` (`tests/observability/`): every PromQL metric exists in the catalog and the code, pushed gauges are always read through `last_over_time`, six dashboards, ten alerts, generated files in sync, and `observability.cloud sync` against a fake Grafana API (dry-run writes nothing; apply order, idempotent updates, secrets never in output). `next build` succeeds.
- **Not verified:** anything that needs a real Grafana Cloud stack — dashboard rendering, OTel→Prometheus metric names, Loki `detected_level`, the exact Grafana provisioning-API payloads, datasource auto-discovery, alert delivery. Checklist: `observability/README.md`. Also not done: applying migration 0010 to Supabase, creating the Grafana Cloud account / tokens (yours), and measuring real overhead and volume.

### Known limits
- `prompt.run` (the root) exists only once a draft is confirmed; compile-only drafts show a missing root in Tempo.
- `llm.chat` spans are created after the fact (`start = now − latency`), so waterfalls are approximate.
- Pre-existing, unrelated: `tests/engine/test_v5_parity.py::...[20]` fails identically without the instrumentation (an extra ticker vs the literal harness); `tests/test_db_migrations.py` fails on `citext` (embedded Postgres lacks it).

## Part C
Phases 5–6 (production cutover, tuning) need D2 (always-on host), D3 (alert channel) and a Supabase project to apply 0010 to. Not started. The Grafana Cloud stack removes the need to host the observability services.
