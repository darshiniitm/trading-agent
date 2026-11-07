# Engine on Docker Swarm (single VM, Mumbai) — implementation plan

**Status:** plan v1.0, 31 Oct 2026 — for Claude Code to implement. **Nothing here is built yet.**
**Owner decision (Dharmin, 31 Oct 2026):** the screening engine runs on **Docker Swarm + a compose-format stack file on one Linux VM**, using the free Docker Engine with no paid Docker plan. This **replaces Fly.io** as decision D1 in `docs/netlify-production-plan.md`. The weekly web-app job moves onto the same host (D5).
**Unchanged:** Netlify hosts the web app; Supabase Postgres holds the app DB; Ollama Cloud + Grafana Cloud as planned. Local dev on the Mac doesn't change (`ENGINE_MANAGED` supervisor, no Docker needed).

---

## 1. Why Swarm, and what it's *not* used for

On one VM, Swarm adds three things over plain `docker compose`: **secrets** (files in `/run/secrets`, never in env files on disk or in `docker inspect`), **controlled updates/rollback** (`update_config`, `docker service rollback`), and **automatic restart** of a failed container. That's the whole reason for using it.

The generic "web + Celery worker + Redis + Postgres" template **doesn't apply** to this engine:

| Template piece | This project | Why |
|---|---|---|
| `gunicorn --workers 4` | **1 uvicorn process, 1 replica** | Each worker would load its own copy of the ~220 MB parquet data (4× RAM). The engine's single-flight lock (`engine/env.py` `_GUARD`/`_LOCKS`) and the refresh slot (`engine/refresh.py` `RefreshState`) are **per process**, so two processes writing `data_cache/` corrupt it (the code comment records this happened before). |
| `celery` worker + `redis` | **none** | The engine has no task queue. Long work (refresh, prefetch) already runs in background threads inside the engine. The web app's long requests use Netlify background functions (`LONG_REQUESTS=background`). |
| `db` (Postgres) service | **none** | Supabase is the database. A second Postgres would be one more thing to back up and keep in sync. |
| — | **`caddy`** | HTTPS in front of the engine (automatic Let's Encrypt). |
| — | **`jobs`** (one-shot) | The weekly catch-up (`Dockerfile.jobs`), started by a host timer. |

---

## 2. What already exists (checked 31 Oct 2026 — read before changing anything)

Claude Code already implemented most of the Netlify plan (commits `48ad4b9` … `11cf955`). Relevant to this plan:

- **`Dockerfile.engine`**: `python:3.11-slim`, copies `engine/ src/ config/ db/ scripts/`, entrypoint `docker/engine-entrypoint.sh`, `ENGINE_DATA_DIR=/data`, `VOLUME /data`, port 8080, `CMD uvicorn --factory engine.app:create_app --host 0.0.0.0 --port ${PORT:-8080}`. Runs as **root**.
- **`docker/engine-entrypoint.sh`** symlinks `/app/{data_cache,data_cache_literal,results}` → `$ENGINE_DATA_DIR/…`, creates `results/prompt_arms`, warns when `ENGINE_TOKEN` is unset, then `exec "$@"`.
- **Engine auth** is built: `engine/app.py` checks `Authorization: Bearer $ENGINE_TOKEN` on everything except `/health` (off when unset). The web client sends the header (`src/server/engine/client.ts`).
- **Engine telemetry** (`src/telemetry/core.py`) reads `OTEL_EXPORTER_OTLP_ENDPOINT/_HEADERS`, `TELEMETRY_DB_URL | SUPABASE_DB_URL`, `OTEL_SERVICE_NAME`.
- **`/health`** returns `{status:"ok", engine_git_sha, last_bar_date, warm:{state…}}`. It answers 200 while still warming, and `engine_git_sha` shells out to `git` (missing in the image, so it reports `"unknown"`).
- **`Dockerfile.jobs`**: `node:20-slim`, `npm ci --omit=optional`, `CMD npx tsx scripts/run-weekly-jobs.ts`. Needs `APP_DB_URL`, `ENGINE_BASE_URL`, `ENGINE_TOKEN`, OTel envs.
- **`fly.engine.toml`** + Fly sections in `docs/runbook-production.md`: the previous D1 choice. **Not deployed.**
- **Data on the Mac** (gitignored): `data_cache/` ~174 MB (`ohlcv/` 132 MB), `data_cache_literal/` ~49 MB, `results/prompt_arms/` (forward records, `registry.json`). User uploads go to `data_cache/uploads` (`engine/resolution/config.py`).
- **Not part of this deployment:** `scripts/weekly_selection_run.sh` (the Python forward test). It calls `claude -p` for the audit step and stays on the Mac.

### Defects to fix while doing this (found in EDA)
1. **`Dockerfile.jobs` uses `node:20-slim`**, but commit `2aa964b` moved the build to Node 22 because the OpenTelemetry packages need ≥ 22.15. → `node:22-slim`.
2. **`engine_git_sha()` is always `"unknown"`** in a container (no git, no `.git`). → read `ENGINE_GIT_SHA` env first, falling back to git. Set it at build time via `--build-arg GIT_SHA`.
3. **No secrets-from-files support.** Both images read config from env vars only. Swarm secrets are files. → entrypoint shim (§4.2).
4. **No container healthcheck.** `python:3.11-slim` has no `curl`. → Python one-liner healthcheck (§4.1).

---

## 3. Target layout on the VM

```
Internet ──443──► caddy (published 80/443, host mode)
                    │  engine.<domain>  → reverse_proxy engine:8080   (TLS by Let's Encrypt)
                    ▼
             overlay network "screener" (attachable, not published)
                    │
       ┌────────────┴─────────────┐
       ▼                          ▼
  engine (1 replica)          jobs (replicas 0; scaled to 1 by a host timer weekly)
  /data ← bind /srv/screener/data   → http://engine:8080 inside the network
       │
       └─► Yahoo / yfinance, Supabase (telemetry), Grafana Cloud OTLP

Netlify functions ──HTTPS + Bearer ENGINE_TOKEN──► https://engine.<domain>
```

---

## 4. Repo changes (Claude Code)

All new files go under **`deploy/swarm/`** so the Mac setup doesn't change.

```
deploy/swarm/
  stack.yml               # the Swarm stack (compose v3.8 format)
  Caddyfile
  bootstrap-host.sh       # one-time VM setup (idempotent)
  deploy.sh               # build images on the VM + docker stack deploy
  run-weekly-jobs.sh      # what the timer runs: scale jobs 0→1, wait, report, scale back to 0
  systemd/screener-jobs.service
  systemd/screener-jobs.timer
  secrets.example         # secret NAMES only, one per line
  README.md               # short: points to docs/runbook-production.md
docker/secrets-env.sh     # shared shim: /run/secrets/* → env vars
```

### 4.1 `stack.yml` (shape — Claude Code fills in exact values)
```yaml
version: "3.8"

networks:
  screener: { driver: overlay, attachable: true }

volumes:
  caddy_data: {}
  caddy_config: {}

secrets:
  engine_token:        { external: true }
  supabase_db_url:     { external: true }   # engine telemetry (Session pooler 5432)
  app_db_url:          { external: true }   # jobs: Transaction pooler 6543
  otlp_headers:        { external: true }   # Grafana Cloud "Authorization=Basic …"

services:
  engine:
    image: screener-engine:${GIT_SHA}
    networks: [screener]
    environment:
      PORT: "8080"
      ENGINE_DATA_DIR: /data
      OTEL_SERVICE_NAME: prompt-screener-engine
      OTEL_EXPORTER_OTLP_ENDPOINT: ${OTEL_EXPORTER_OTLP_ENDPOINT}
      OTEL_EXPORTER_OTLP_PROTOCOL: http/protobuf
      ENGINE_GIT_SHA: ${GIT_SHA}
    secrets:
      - { source: engine_token,    target: ENGINE_TOKEN }
      - { source: supabase_db_url, target: SUPABASE_DB_URL }
      - { source: otlp_headers,    target: OTEL_EXPORTER_OTLP_HEADERS }
    volumes:
      - type: bind
        source: /srv/screener/data
        target: /data
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/health',timeout=5).status==200 else 1)"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 300s          # warm-up loads ~220 MB of parquet + builds indexes; measure and adjust
    deploy:
      replicas: 1                 # NEVER more than 1 (see §1)
      update_config:
        order: stop-first         # old engine fully stops before the new one starts: never two writers on /data
        failure_action: rollback
        monitor: 360s
      rollback_config: { order: stop-first }
      restart_policy: { condition: any, delay: 10s, window: 120s }
      resources:
        limits:       { memory: 3G }
        reservations: { memory: 1500M }
    logging: { driver: json-file, options: { max-size: "20m", max-file: "5" } }

  caddy:
    image: caddy:2.8                    # pin an exact minor; bump deliberately
    networks: [screener]
    ports:
      - { target: 80,  published: 80,  mode: host }
      - { target: 443, published: 443, mode: host }
    configs: [{ source: caddyfile, target: /etc/caddy/Caddyfile }]
    volumes: [caddy_data:/data, caddy_config:/config]
    environment: { ENGINE_DOMAIN: ${ENGINE_DOMAIN}, ACME_EMAIL: ${ACME_EMAIL} }
    deploy: { replicas: 1, restart_policy: { condition: any } }

  jobs:
    image: screener-jobs:${GIT_SHA}
    networks: [screener]
    environment:
      ENGINE_BASE_URL: http://engine:8080      # stays inside the overlay network, no TLS hop
      OTEL_SERVICE_NAME: prompt-screener-jobs
      OTEL_EXPORTER_OTLP_ENDPOINT: ${OTEL_EXPORTER_OTLP_ENDPOINT}
    secrets:
      - { source: app_db_url,   target: APP_DB_URL }
      - { source: app_db_url,   target: TELEMETRY_DB_URL }
      - { source: engine_token, target: ENGINE_TOKEN }
      - { source: otlp_headers, target: OTEL_EXPORTER_OTLP_HEADERS }
    deploy:
      replicas: 0                 # only the host timer starts it
      restart_policy: { condition: none }

configs:
  caddyfile: { file: ./Caddyfile, name: caddyfile_${CADDYFILE_HASH} }   # configs are immutable; name by content hash so changes deploy
```
Non-secret values (`GIT_SHA`, `ENGINE_DOMAIN`, `ACME_EMAIL`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `CADDYFILE_HASH`) come from `/srv/screener/stack.env`, which `deploy.sh` sources before `docker stack deploy` (Swarm doesn't read `.env` files itself).

### 4.2 Secrets → env shim (`docker/secrets-env.sh`)
```sh
# Source from an entrypoint: every file in /run/secrets becomes an env var of the same name, unless already set.
if [ -d /run/secrets ]; then
  for f in /run/secrets/*; do
    [ -f "$f" ] || continue
    n=$(basename "$f")
    case "$n" in *[!A-Z0-9_]*) continue ;; esac      # only NAME-shaped files
    eval "[ -n \"\${$n:-}\" ]" || export "$n=$(cat "$f")"
  done
fi
```
- `docker/engine-entrypoint.sh`: `. /usr/local/bin/secrets-env` as its first step. The `ENGINE_TOKEN` warning then works unchanged.
- `Dockerfile.jobs`: add a 3-line entrypoint that sources the same shim and then `exec npx tsx scripts/run-weekly-jobs.ts`.
- Never `echo` secret values. `set -x` must stay off in these scripts.

### 4.3 Image changes
- `Dockerfile.engine`:
  - `ARG GIT_SHA=unknown` + `ENV ENGINE_GIT_SHA=$GIT_SHA`.
  - Copy the shim.
  - **Run as non-root:** `useradd -u 10001 engine`. The entrypoint creates the symlinks **before** dropping privileges, or `/app` is chowned in the image (pick one; the simplest is `chown engine /app` + `USER engine`, since the symlinks live in `/app`). The bind-mounted `/srv/screener/data` is chowned to `10001` by `bootstrap-host.sh`.
- `engine/health.py`: `engine_git_sha()` returns `os.environ["ENGINE_GIT_SHA"]` when set, else today's git call. Add a unit test for both branches.
- `Dockerfile.jobs`: `node:22-slim`, the entrypoint above, `ARG/ENV GIT_SHA`.
- Leave `Dockerfile.engine`'s `VOLUME ["/data"]` as is. The bind mount overrides it.

### 4.4 `Caddyfile`
```
{
  email {$ACME_EMAIL}
}
{$ENGINE_DOMAIN} {
  encode gzip
  reverse_proxy engine:8080 {
    health_uri /health
    transport http { read_timeout 120s }   # /screen on a cold cache can be slow; keep below Netlify's 60 s budget on the caller side anyway
  }
  request_body { max_size 8MB }            # CSV uploads go through /data/upload
  log { output stdout format json }
}
```
- The bearer-token check stays in the engine (one source of truth). Caddy only does TLS and proxying.
- Optional later: a per-IP rate limit (needs a Caddy plugin build). Not in v1.

### 4.5 `bootstrap-host.sh` (idempotent; run once as root on a fresh Ubuntu 24.04 LTS VM)
1. Set `timedatectl set-timezone Asia/Kolkata`, apply OS updates, enable unattended security upgrades.
2. Install Docker Engine from Docker's apt repo (Docker CE, free). **No Docker Desktop**, no paid plan.
3. `/etc/docker/daemon.json`: `{"log-driver":"json-file","log-opts":{"max-size":"20m","max-file":"5"},"live-restore":false}` (live-restore isn't supported with Swarm).
4. `docker swarm init --advertise-addr 127.0.0.1` (single node: Swarm's management/overlay ports 2377/7946/4789 are never exposed).
5. Firewall (`ufw`): allow 22 (ideally only from Dharmin's IP), 80, 443; deny everything else inbound. Note: Docker-published ports bypass ufw, but only Caddy publishes anything, so that's fine.
6. SSH: key-only login, no root login, a `deploy` user in the `docker` group.
7. `mkdir -p /srv/screener/data/{data_cache,data_cache_literal,results/prompt_arms}`, `chown -R 10001:10001 /srv/screener/data`.
8. Optional 2 GB swapfile as a safety net against OOM kills during warm-up.
9. Install the systemd timer from `deploy/swarm/systemd/`.

### 4.6 `deploy.sh` (run on the VM, from a checkout at `/srv/screener/repo`)
1. `git fetch && git checkout <sha|main>`; `GIT_SHA=$(git rev-parse --short HEAD)`.
2. `docker build -f Dockerfile.engine --build-arg GIT_SHA=$GIT_SHA -t screener-engine:$GIT_SHA .` and the same for `Dockerfile.jobs`.
3. `CADDYFILE_HASH=$(sha256sum deploy/swarm/Caddyfile | cut -c1-12)`; source `/srv/screener/stack.env`; `docker stack deploy -c deploy/swarm/stack.yml --prune screener`.
4. Wait until `docker service ps screener_engine` shows Running/healthy and `curl -fsS https://$ENGINE_DOMAIN/health` reports `engine_git_sha == $GIT_SHA`. Print `warm.state`.
5. Keep the last 3 image tags (`docker image prune` the rest) so rollback never needs a rebuild.

**Image registry:** none in v1. Images are built on the VM itself, which works for a single-node swarm (Swarm prints a harmless "image could not be accessed on a registry" warning). This avoids Docker Hub's free-plan limit of one private repo and GHCR's free private-storage cap. Revisit if a second node or CI builds are added (§8).

### 4.7 Weekly job: `run-weekly-jobs.sh` + systemd timer
Swarm has no built-in cron, so a host systemd timer drives a `replicas: 0` service:
```sh
docker service scale -d screener_jobs=0
docker service scale -d screener_jobs=1
# wait until the task reaches Complete/Failed (poll `docker service ps screener_jobs --format '{{.CurrentState}}'`, timeout 60 min)
docker service logs --raw --since 2h screener_jobs > /srv/screener/logs/jobs-$(date +%F).log
docker service scale -d screener_jobs=0
# exit non-zero if the task Failed, so systemd records the failure (and an OnFailure= unit can alert later)
```
- `screener-jobs.timer`: `OnCalendar=<D-S3 schedule> Asia/Kolkata`, `Persistent=false`. **Don't** catch up a missed run late, to honour the pre-open recording rule. `run-weekly-jobs.ts` already treats each prompt idempotently.
- Trigger by hand: `systemctl start screener-jobs.service`.
- The script reaches the engine at `http://engine:8080` inside the overlay network, with no public hop.

### 4.8 Docs to update in the same PR
- `docs/runbook-production.md`: replace every Fly command with its Swarm equivalent in setup step 3, Deploy, Roll back, Rotate secrets, Logs, Weekly jobs and Restore (table in §6). Keep a short "Alternative: Fly.io" note pointing at `fly.engine.toml`.
- `fly.engine.toml`: add a header line "Alternative, not the chosen host (see docs/engine-swarm-deploy-plan.md)". Don't delete it.
- `frontend/apps/web/.env.production.example`: `ENGINE_BASE_URL=https://engine.<your-domain>`.
- `docs/netlify-production-plan.md` §5.1 / §8 / §10 D1, D5: point to this plan (already done in the 31 Oct edit).

### 4.9 Tests (CI-runnable, no VM needed)
- `docker build` both images. A `docker run` smoke test of the engine with `ENGINE_TOKEN=t` and an empty `/data` tmpfs (offline mode if available): `/health` → 200, `/conditions/v5` without a token → 401, with the token → 200.
- Shim test: a container with a fake `/run/secrets/FOO` sees `$FOO`, an already-set env var isn't overwritten, and a file named `foo.bar` is ignored.
- `docker stack config -c deploy/swarm/stack.yml` (or `docker compose -f … config`) validates.
- `shellcheck` on all `deploy/swarm/*.sh` and `docker/*.sh`.
- Python test for `engine_git_sha()` env override.

---

## 5. Phases

| Phase | Who | Work | Est. |
|---|---|---|---|
| **S0 Choose + create the VM** | Dharmin | Pick provider (D-S1), create the VM in Mumbai, add an SSH key, point `engine.<domain>` A record at its IP (D-S2) | ½ d |
| **S1 Repo changes** | Claude Code | §4.1–§4.4, §4.6–§4.9 on a branch, PR with tests green | 1 d |
| **S2 Host bootstrap** | Claude Code writes, Dharmin runs | `bootstrap-host.sh`; create Swarm secrets (`printf '%s' "$VALUE" \| docker secret create engine_token -`; never put values in shell history or files); write `/srv/screener/stack.env` | ½ d |
| **S3 Seed data + first deploy** | Dharmin + Claude Code | `rsync -a --info=progress2 data_cache data_cache_literal results/prompt_arms deploy@vm:/srv/screener/data/` from the Mac, `chown -R 10001`; `deploy.sh`; wait for `warm.state=ready`; record warm-up time and engine RSS (`docker stats`) and adjust `start_period` / memory limits | ½ d |
| **S4 Wire Netlify + jobs + backups** | Dharmin + Claude Code | Netlify `ENGINE_BASE_URL`/`ENGINE_TOKEN`; `/api/health?deep=1` shows engine ok; run the jobs service once by hand; set up backups (§7) and do one restore test | ½ d |

**Total ≈ 3 days**, of which about 1½ days are Dharmin's hands-on steps.

---

## 6. Runbook equivalents (Fly → Swarm)

| Task | Swarm |
|---|---|
| Deploy | `ssh deploy@vm 'cd /srv/screener/repo && ./deploy/swarm/deploy.sh main'` |
| Roll back | `docker service rollback screener_engine` (previous spec), or `deploy.sh <previous-sha>` (images kept, §4.6) |
| Logs | `docker service logs -f --since 1h screener_engine`; Caddy: `… screener_caddy`; jobs: `/srv/screener/logs/` |
| Status | `docker service ps screener_engine`; `curl https://engine.<domain>/health` |
| Rotate `ENGINE_TOKEN` | `docker secret create engine_token_v2 -` → change `source:` in `stack.yml` (secrets are immutable) → `deploy.sh` → update the Netlify env var + redeploy → `docker secret rm engine_token` |
| Restart engine | `docker service update --force screener_engine` (stop-first, so there's a short outage while it warms up) |
| Run weekly job now | `sudo systemctl start screener-jobs.service` |

**Outage on every engine deploy:** stop-first means requests fail until the new engine is ready. The web app already shows the engine's `starting` state (`/api/engine/status`), and the `/health` probe answers during warm-up. Deploy outside Indian market hours, and never between the weekly job's start and finish.

---

## 7. Backups and monitoring
- **What matters:** `results/prompt_arms/` (forward records + `registry.json`) and `data_cache/uploads/` (user uploads). These can't be rebuilt. The parquet caches can be re-downloaded from Yahoo, slowly.
- **Nightly:** `restic` (or `tar | gzip`) of those two folders → off-box storage (D-S4), keeping 30 days. Weekly provider snapshot of the whole VM disk.
- **Restore test** once in S4: restore into a scratch folder and diff it.
- **Monitoring:** engine traces/metrics already go to Grafana Cloud. Add an **uptime check** on `https://engine.<domain>/health` (Grafana Cloud synthetic monitoring, or the existing alert webhook) and disk-usage alerting on the VM (Grafana Alloy agent, optional, v1.1).

---

## 8. Out of scope for v1
- More than one Swarm node or engine replica. That first needs the engine's data in Postgres (`DATA_BACKEND=postgres`) or a shared lock.
- CI-built images + a registry (GitHub Actions → GHCR/Docker Hub).
- The Python forward-test run (`weekly_selection_run.sh`) in production; it stays on the Mac.
- Caddy rate limiting, WAF, or an IP allowlist (Netlify function egress IPs aren't fixed; token + TLS is the control).
- Licensed NSE data / SEBI review (unchanged from the Netlify plan §9).

---

## 9. Decisions needed from Dharmin
1. **D-S1 VM provider (Mumbai/India region, Ubuntu 24.04, 2 vCPU / 4 GB RAM / ≥ 50 GB SSD, static IP):** AWS Lightsail `ap-south-1`, AWS EC2 `ap-south-1`, DigitalOcean `BLR1`, or Oracle Cloud (Mumbai/Hyderabad; its free ARM tier is enough, but check pandas/pyarrow arm64 wheels in S1). Compare current prices when choosing; this plan doesn't assume any.
2. **D-S2 Engine domain:** a subdomain such as `engine.<your-domain>`. Caddy needs a real DNS name for the HTTPS certificate.
3. **D-S3 Weekly job time (IST):** the latest time that still satisfies the pre-open recording rule for Monday entries, e.g. Monday 08:30 IST. Your call.
4. **D-S4 Backup target:** Supabase Storage, AWS S3 (same account as the VM if Lightsail/EC2), or Backblaze B2.
5. **D-S5 Who has SSH:** just you, or a teammate too. Each gets their own key; no shared passwords.

---

## 10. Decisions taken (6 Nov 2026)
- **D-S1 VM provider (superseded 6 Nov 2026: Oracle dropped, AWS Lightsail Mumbai `ap-south-1`, Ubuntu 24.04 x86, 4 GB+ RAM, static IP):** was Oracle Cloud Always Free Ampere `VM.Standard.A1.Flex` (arm64; 2 OCPU / 12 GB target, default ~47 GB boot volume), Mumbai/Hyderabad. All Python deps have aarch64 wheels (checked); Node 22 and Caddy images are multi-arch. The 1 GB `E2.1.Micro` shape is too small. Fallback if A1 stays out of capacity: AWS Lightsail Mumbai.
- **D-S2 Engine domain:** open (custom domain on the live Netlify site, or `engine.<ip>.sslip.io`).
- **D-S3 Weekly job time:** Monday 08:30 IST (as in `deploy/swarm/systemd/screener-jobs.timer`).
- **D-S4 Backup target:** Supabase Storage via its S3-compatible endpoint (restic).
- **Docker:** free Docker Engine CE + Swarm; no paid Docker plan needed (no registry, no Desktop on the VM). Revisit only if CI-built images or a registry are added (§8).
- **Repo work (S1)** implemented 31 Oct–6 Nov 2026; `.dockerignore` no longer excludes `frontend/` (the jobs image could not build from the repo root before).
