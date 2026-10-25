# Production runbook — prompt-screener on Netlify + engine service + Supabase

Companion to [`netlify-production-plan.md`](netlify-production-plan.md) (the why) — this is the how. Written 26 Oct 2026 alongside
the implementation; **nothing in it has been exercised against production yet** (no Netlify site, engine host or production Supabase
project existed when it was written). Treat each section as a checklist to verify the first time, then correct it.

## Moving parts

| Piece | Where | Config in repo |
|---|---|---|
| Web app (Next.js 14: pages, API routes, middleware) | Netlify | `netlify.toml`, `frontend/apps/web/.env.production.example` |
| App database (`screener_app.*`) | Supabase Postgres, Transaction pooler `:6543` | `db/migrations/0011_screener_app_full.sql` |
| Screening engine (FastAPI + parquet caches) | Always-on container with a volume, e.g. Fly.io `bom` | `Dockerfile.engine`, `docker/engine-entrypoint.sh`, `fly.engine.toml` |
| Weekly jobs | Scheduled one-shot next to the engine | `Dockerfile.jobs`, `frontend/apps/web/scripts/run-weekly-jobs.ts` |
| LLM | Ollama Cloud | `OLLAMA_*` env |
| Traces / metrics / logs | Grafana Cloud OTLP + `observability.*` tables | `OTEL_*`, `TELEMETRY_DB_URL` |

## First-time setup (order matters)

1. **Supabase (production project).** `python -m db.migrate` against it (uses `SUPABASE_DB_URL`, Session pooler `:5432`). Migration 0011
   refuses to run if the old warehouse placeholders (`user_prompts`, `watchlists`, …) hold rows, and sets
   `search_path = screener_app, public` on the role that ran it. **Run it as the same role the app connects as** (the default
   `postgres.<ref>` user), or set the search_path on the app's role yourself.
2. **Move the data** (once, from the Mac that has `data/app.db`):
   ```bash
   cd frontend/apps/web
   APP_DB_URL='postgresql://…:5432/postgres' npm run db:move-sqlite -- data/app.db
   ```
   It keeps every numeric id, runs in one transaction, refuses a non-empty target, and prints matching row counts.
   Spot-check one prompt → draft → run → watchlist chain in the app afterwards.
3. **Engine service.** Create the app + volume, set secrets (`ENGINE_TOKEN`, `SUPABASE_DB_URL`, `OTEL_*`), deploy
   (`fly.engine.toml` has the exact commands). Seed the volume once from the Mac so the first warm-up does not re-download five
   years of bars: copy `data_cache/`, `data_cache_literal/`, `results/prompt_arms/` into `/data/…`. Wait for
   `GET <engine>/health` → `warm.state = "ready"`. Requests without `Authorization: Bearer $ENGINE_TOKEN` must get 401 (except `/health`).
4. **Netlify site** from the GitHub repo (Base directory `frontend`, Package directory `apps/web`), env vars from `.env.production.example`
   (secrets marked secret, scoped to Functions). Set `ENGINE_BASE_URL` + `ENGINE_TOKEN` to the engine from step 3, and
   `APP_DB_URL` to the **Transaction pooler** string. Production branch `main`; Deploy Previews use the *staging* Supabase project.
5. **Supabase Auth** → URL configuration: Site URL = `APP_URL`; Redirect URLs = `https://<domain>/auth/callback`
   (+ the Deploy Preview pattern on the staging project only). Google/GitHub OAuth apps call back to Supabase, not Netlify.
6. **Verify:** `curl https://<site>/api/health?deep=1` → `{"ok":true,"db":{"ok":true},"engine":{"ok":true,"warm":"ready"},"model":{"state":"ok"}}`.
   Then the go-live checklist in the plan (§12).

## Deploy

- **Web:** merge to `main`; Netlify builds and publishes. PRs get a Deploy Preview.
- **Engine:** `fly deploy --config fly.engine.toml`. The image is stateless; the volume keeps the data.
- **Schema change:** write `db/migrations/00NN_*.sql`, apply it to staging, then production (`python -m db.migrate`) **before** merging
  the code that needs it. Migrations are checksum-locked once applied: never edit an applied file, add a new one.

## Roll back

- **Web:** Netlify → Deploys → pick the previous good deploy → *Publish deploy*. (The database is not rolled back; keep migrations backward compatible for one release.)
- **Engine:** `fly releases` → `fly deploy --image <previous image>`.
- **Data:** see *Restore* below.

## Rotate secrets

| Secret | How |
|---|---|
| `OLLAMA_API_KEY` | create a new key at Ollama Cloud, update the Netlify env var, trigger a deploy, revoke the old key |
| `ENGINE_TOKEN` | `fly secrets set ENGINE_TOKEN=<new>` (restarts the engine) **and** update the Netlify env var + redeploy, in that order within a few minutes; both the weekly job and the web app use it |
| Supabase DB password | reset in Supabase, update `APP_DB_URL` / `TELEMETRY_DB_URL` in Netlify and `SUPABASE_DB_URL` on the engine + jobs |
| Anything that was ever pasted into a chat or committed | treat as leaked: rotate it |

## Logs

- Web: Netlify → Logs → Functions (per route). Cold starts and the start-up model check are logged there.
- Engine: `fly logs`. Health: `GET <engine>/health`.
- Traces: Grafana Cloud (one trace per prompt run, web → engine); run records in `observability.*`.

## Weekly jobs

One-shot container built from `Dockerfile.jobs`, scheduled next to the engine, e.g. on Fly:
```bash
fly machine run --schedule weekly --region bom --app <jobs-app> <image> \
  -e APP_DB_URL=… -e ENGINE_BASE_URL=http://<engine>.internal:8080 -e ENGINE_TOKEN=…
```
`run-weekly-jobs` catches up every confirmed prompt (screen → select → grade) and then refreshes watchlist view metrics; a failure on one
prompt is logged and does not stop the others. Run it by hand the first time and read the output.

## Restore

- **Database:** Supabase daily backups (Pro) or a nightly `pg_dump` of the `screener_app` schema for the free tier. Test a restore once into the staging project.
- **Engine volume:** Fly volume snapshots (`fly volumes snapshots list`); restore by creating a volume from a snapshot. The parquet caches can also be rebuilt from Yahoo, slowly.

## Known gaps / not built

- Long requests (plan §6.2, decision D3): by default the interpreter runs inside the 60 s function limit with a 50 s model time budget (`COMPILE_DEADLINE_MS`); past it the rules' reading is returned and the model is reported unavailable. If the timing run against Ollama Cloud shows p99 ≥ 45 s, set `LONG_REQUESTS=background` and `JOB_SECRET`: `POST /api/drafts/:id/program` and `/program/screen` then answer `202 {jobId}`, the `draft-job-background` function (bundled by `npm run build:functions`, 15 min) runs the same single pipeline, and the page polls `GET /api/jobs/:id` (the client follows this automatically). **Built and unit-tested, but never run on Netlify:** verify in the first Deploy Preview that Netlify picks up `apps/web/netlify/functions` (see the comment in `netlify.toml` if it resolves from the repo root) and that the function can import its externals. The prompt-edit route (`program/answer` with `edit`) still compiles synchronously.
- A new benchmark's metrics are computed inline on Netlify (the request waits); other background metric top-ups are skipped there and left to the weekly job and the refresh button.
- Licensed NSE data and the SEBI review (plan §9) are prerequisites for outside users, not for this deployment.
