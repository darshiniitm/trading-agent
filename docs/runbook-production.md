# Production runbook — prompt-screener on Netlify + engine service + Supabase

Companion to [`netlify-production-plan.md`](netlify-production-plan.md) (the why) — this is the how. Written 26 Oct 2026 alongside
the implementation; **nothing in it has been exercised against production yet** (no Netlify site, engine host or production Supabase
project existed when it was written). Treat each section as a checklist to verify the first time, then correct it.

## Moving parts

| Piece | Where | Config in repo |
|---|---|---|
| Web app (Next.js 14: pages, API routes, middleware) | Netlify | `netlify.toml`, `frontend/apps/web/.env.production.example` |
| App database (`screener_app.*`) | Supabase Postgres, Transaction pooler `:6543` | `db/migrations/0011_screener_app_full.sql` |
| Screening engine (FastAPI + parquet caches) | Docker Swarm stack on one Linux VM (Mumbai): engine + Caddy (TLS), data on a bind-mounted dir | `Dockerfile.engine`, `docker/`, `deploy/swarm/` (plan: [`engine-swarm-deploy-plan.md`](engine-swarm-deploy-plan.md)) |
| Weekly jobs | One-shot Swarm service (`replicas: 0`) started by a host systemd timer | `Dockerfile.jobs`, `frontend/apps/web/scripts/run-weekly-jobs.ts` |
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
3. **Engine service (Swarm VM).** Create an Ubuntu 24.04 VM in Mumbai (2 vCPU / 4 GB / ≥ 50 GB), point `engine.<domain>` at it, then:
   ```bash
   # on the VM, as root, from a checkout (git clone … /srv/screener/repo); add your key to /home/deploy/.ssh/authorized_keys first
   sudo ./deploy/swarm/bootstrap-host.sh --ssh-allow-ip <your-ip>
   # as deploy: create the secrets (names in deploy/swarm/secrets.example); type each value, never put it in shell history or a file
   printf '%s' "$VALUE" | docker secret create engine_token -
   cp deploy/swarm/stack.env.example /srv/screener/stack.env   # then edit: ENGINE_DOMAIN, ACME_EMAIL, OTEL endpoint
   ```
   Seed the data once from the Mac so the first warm-up does not re-download five years of bars, then deploy:
   ```bash
   rsync -aR --info=progress2 data_cache data_cache_literal results/prompt_arms deploy@<vm>:/srv/screener/data/   # -R keeps the relative path, so prompt_arms lands in data/results/
   ssh root@<vm> chown -R 10001:10001 /srv/screener/data
   ssh deploy@<vm> 'cd /srv/screener/repo && ./deploy/swarm/deploy.sh main'
   ```
   Wait for
   `GET https://engine.<domain>/health` → `warm.state = "ready"`; record warm-up time and `docker stats` RSS and adjust `start_period` / memory limits in `stack.yml`. Requests without `Authorization: Bearer $ENGINE_TOKEN` must get 401 (except `/health`).
4. **Netlify site** from the GitHub repo (Base directory `frontend`, Package directory `apps/web`), env vars from `.env.production.example`
   (secrets marked secret, scoped to Functions). Set `ENGINE_BASE_URL` + `ENGINE_TOKEN` to the engine from step 3, and
   `APP_DB_URL` to the **Transaction pooler** string. Production branch `main`; Deploy Previews use the *staging* Supabase project.
5. **Supabase Auth** → URL configuration: Site URL = `APP_URL`; Redirect URLs = `https://<domain>/auth/callback`
   (+ the Deploy Preview pattern on the staging project only). Google/GitHub OAuth apps call back to Supabase, not Netlify.
6. **Verify:** `curl https://<site>/api/health?deep=1` → `{"ok":true,"db":{"ok":true},"engine":{"ok":true,"warm":"ready"},"model":{"state":"ok"}}`.
   Then the go-live checklist in the plan (§12).

## Deploy

- **Web:** merge to `main`; Netlify builds and publishes. PRs get a Deploy Preview.
- **Engine:** `ssh deploy@<vm> 'cd /srv/screener/repo && ./deploy/swarm/deploy.sh main'`. The image is stateless; `/srv/screener/data` keeps the data. Updates are stop-first, so the engine is down while the new one warms up: deploy outside Indian market hours and never between the weekly job's start and finish.
- **Schema change:** write `db/migrations/00NN_*.sql`, apply it to staging, then production (`python -m db.migrate`) **before** merging
  the code that needs it. Migrations are checksum-locked once applied: never edit an applied file, add a new one.

## Roll back

- **Web:** Netlify → Deploys → pick the previous good deploy → *Publish deploy*. (The database is not rolled back; keep migrations backward compatible for one release.)
- **Engine:** `docker service rollback screener_engine` (previous spec), or `./deploy/swarm/deploy.sh <previous-sha>` (the last 3 image tags are kept, so no rebuild).
- **Data:** see *Restore* below.

## Rotate secrets

| Secret | How |
|---|---|
| `OLLAMA_API_KEY` | create a new key at Ollama Cloud, update the Netlify env var, trigger a deploy, revoke the old key |
| `ENGINE_TOKEN` | Swarm secrets are immutable: `docker secret create engine_token_v2 -`, change `source:` for `engine_token` in `deploy/swarm/stack.yml` (both `engine` and `jobs`), `deploy.sh`, then update the Netlify env var + redeploy within a few minutes, then `docker secret rm engine_token` |
| Supabase DB password | reset in Supabase, update `APP_DB_URL` / `TELEMETRY_DB_URL` in Netlify and `SUPABASE_DB_URL` / `APP_DB_URL` secrets on the VM (same create-v2 / swap / remove flow) |
| Anything that was ever pasted into a chat or committed | treat as leaked: rotate it |

## Logs

- Web: Netlify → Logs → Functions (per route). Cold starts and the start-up model check are logged there.
- Engine: `docker service logs -f --since 1h screener_engine`; Caddy: `… screener_caddy`; weekly jobs: `/srv/screener/logs/`. Status: `docker service ps screener_engine`; health: `GET https://engine.<domain>/health`.
- Traces: Grafana Cloud (one trace per prompt run, web → engine); run records in `observability.*`.

## Weekly jobs

One-shot Swarm service built from `Dockerfile.jobs` (`replicas: 0`); the host systemd timer `screener-jobs.timer` (schedule: decision D-S3, `Persistent=false` so a missed run is never caught up late) runs `deploy/swarm/run-weekly-jobs.sh`, which scales it 0→1, waits, saves the log to `/srv/screener/logs/`, scales back to 0 and exits non-zero on failure. It reaches the engine at `http://engine:8080` inside the overlay network. Run now: `sudo systemctl start screener-jobs.service`.

`run-weekly-jobs` catches up every confirmed prompt (screen → select → grade) and then refreshes watchlist view metrics; a failure on one
prompt is logged and does not stop the others. Run it by hand the first time and read the output.

## Restore

- **Database:** Supabase daily backups (Pro) or a nightly `pg_dump` of the `screener_app` schema for the free tier. Test a restore once into the staging project.
- **Engine data:** what cannot be rebuilt is `results/prompt_arms/` (forward records, `registry.json`) and `data_cache/uploads/` (user uploads): back them up nightly (restic or tar → off-box storage, decision D-S4, keep 30 days) plus a weekly provider disk snapshot; restore into a scratch folder and diff once. The parquet caches can be rebuilt from Yahoo, slowly.

## Production additions (Engine Production Plan, 6 Nov 2026)

- **CI deploy by digest:** `.github/workflows/ci.yml` tests, builds, Trivy-scans (CRITICAL fails) and pushes `engine`/`jobs` to GHCR; the digests are in the run summary. `make deploy ENGINE_DIGEST=sha256:.. JOBS_DIGEST=sha256:.. SHA=<git sha> VM=.. ZONE=.. PROJECT=..` runs `deploy/swarm/deploy-digest.sh` over IAP SSH; `make rollback` runs `docker service rollback screener_engine`. Set `GHCR_REPO` in `/srv/screener/stack.env` and log the deploy user in to GHCR with a read-only token. The CI file has `PIN_ME` placeholders: pin each action to a commit SHA before the first run.
- **Per-user plugin keys:** set the `api_pepper` Swarm secret (`openssl rand -hex 32`), apply migration `0013`, then `python -m engine.apikeys issue --label <who>` (key shown once), `revoke <key_id>`, `list`. Defaults: 120 requests/min/key (`API_RATE_LIMIT_PER_MIN`), 1 MB body (`API_MAX_BODY_BYTES`), 25 MB for `/data/upload`. `ENGINE_TOKEN` stays for the web app. The engine runs as one replica by design, so the rate limiter is exact.
- **Holiday skip:** `run-weekly-jobs.sh` exits 0 on weekends and dates in `config/nse_holidays.yaml` (`FORCE_RUN=1` overrides). **That list is empty: fill it from NSE's circular, or only weekends are skipped.**
- **Disk metric / backups:** `screener-disk.timer` (15 min, `screener_disk_used_ratio`) and `screener-backup.timer` (Sunday 03:00 IST, `pg_dump` to `$BACKUP_BUCKET`, needs `postgresql-client`, gcloud and a root-only `/srv/screener/secrets/supabase_db_url`). Set a 90-day lifecycle rule on the bucket.
- **Alerts to create in Grafana Cloud:** Friday screen / Monday selection `screener_job_last_success_timestamp` missing at 20:00 / 09:45 IST; synthetic check on `/health` failing 3 min (also TLS expiry < 14 days); API 5xx > 2%; `screener_disk_used_ratio` > 0.8.
- **Crash output and Caddy logs stay on the VM:** `docker service logs screener_engine`, `docker service logs screener_caddy`, `docker service ps screener_engine --no-trunc`.
- **Drills to run and note here:** restore a VM from last night's snapshot and check `/health`; deploy a deliberately broken image, then `make rollback`.

## Known gaps / not built

- Long requests (plan §6.2, decision D3): by default the interpreter runs inside the 60 s function limit with a 50 s model time budget (`COMPILE_DEADLINE_MS`); past it the rules' reading is returned and the model is reported unavailable. If the timing run against Ollama Cloud shows p99 ≥ 45 s, set `LONG_REQUESTS=background` and `JOB_SECRET`: `POST /api/drafts/:id/program` and `/program/screen` then answer `202 {jobId}`, the `draft-job-background` function (bundled by `npm run build:functions`, 15 min) runs the same single pipeline, and the page polls `GET /api/jobs/:id` (the client follows this automatically). **Built and unit-tested, but never run on Netlify:** verify in the first Deploy Preview that Netlify picks up `apps/web/netlify/functions` (see the comment in `netlify.toml` if it resolves from the repo root) and that the function can import its externals. The prompt-edit route (`program/answer` with `edit`) still compiles synchronously.
- A new benchmark's metrics are computed inline on Netlify (the request waits); other background metric top-ups are skipped there and left to the weekly job and the refresh button.
- Licensed NSE data and the SEBI review (plan §9) are prerequisites for outside users, not for this deployment.

## Alternative: Fly.io

The earlier engine-host choice (decision D1) is kept as `fly.engine.toml`; it is not deployed and not the chosen host.
