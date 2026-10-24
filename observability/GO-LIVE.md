# Go-live checklist: Grafana Cloud observability

The app, engine, weekly jobs and evals send OTLP to a Grafana Cloud stack; run records go to Supabase `observability.*`; dashboards and
alerts are generated from code and uploaded by `python -m observability.cloud`. **Nothing here has been run against a real stack yet.**
The account, token and database steps are yours: keep every secret in the gitignored `.env` files and never paste one into chat or a
commit. See [`README.md`](README.md) for how the pieces fit and [`../docs/production-llm-cloud-observability-plan.md`](../docs/production-llm-cloud-observability-plan.md) for the decisions.

Legend: 🧑 you · 🤖 Claude can help once you ask.

---

## Part 1: Grafana Cloud (steps 1–2 from your list, expanded)

**1. Create or open the stack** 🧑
1. grafana.com → sign in → **My Account** → pick your stack (or *Create stack*; the free tier is fine to start, region nearest you).
2. Note the stack URL, e.g. `https://<stack>.grafana.net` → this is `GRAFANA_URL`.

**2. OTLP endpoint, instance ID and OTLP token** 🧑 (for *sending* telemetry)
1. On the stack's page in My Account, open the **OpenTelemetry** tile → **Configure** (labels may differ slightly; it is the "send OpenTelemetry data" page).
   **If the wizard asks "where does your application run?":** it runs **locally on your Mac** for now: a Next.js server (Node.js) that starts a Python engine as a child process, plus one-off Python / `tsx` scripts. No Docker, no Kubernetes. Pick the generic / standalone option ("Other", "Linux / VM / local"), choose **send directly with the OpenTelemetry SDK (OTLP)** rather than via a collector or Alloy, and **Node.js** as the language (Python uses the same settings). Ignore its code snippets: the app is already instrumented. All you need from that page is the endpoint, the instance ID and the token. This stays the same later, wherever you host the app (decision D2): it is just these environment variables.
2. Copy the **OTLP endpoint**, e.g. `https://otlp-gateway-prod-<region>.grafana.net/otlp` → `OTEL_EXPORTER_OTLP_ENDPOINT`.
3. Copy the **Instance ID** (a number) → `GRAFANA_OTLP_INSTANCE_ID`.
4. **Generate a token** on that page. It creates an access policy; it must allow **metrics:write, logs:write, traces:write**. Copy it once → `GRAFANA_OTLP_TOKEN`. (Prefix usually `glc_`.)

**2b. Check the OTLP credentials before wiring anything** 🧑 (Grafana's wizard shows a test curl; as pasted, `Authorization: Basic ` has an **empty** credential, so it returns 401)
```bash
set -a; source observability/.env; set +a            # loads the gitignored file into this shell only
curl -i -X POST "$OTEL_EXPORTER_OTLP_ENDPOINT/v1/traces" \
  -u "$GRAFANA_OTLP_INSTANCE_ID:$GRAFANA_OTLP_TOKEN" \
  -H "Content-Type: application/json" -d '{}'
```
`-u` makes curl build the Basic header itself (do **not** reuse `OTEL_EXPORTER_OTLP_HEADERS` in `-H`: it has `%20` for the space). `-i` prints headers/status only, so nothing secret is shown. `{}` is an empty, valid OTLP payload that stores nothing.
- **200**: endpoint, instance ID and token scope are good. Repeat with `/v1/metrics` and `/v1/logs`.
- **401**: wrong instance ID or token. **403**: token lacks that signal's `:write` scope. **404**: endpoint is missing the `/otlp` suffix.

**2c. Or let the repo check it for you** 🧑 (same test for traces, metrics and logs; also tests the service-account token once you have it)
```bash
python -m observability.cloud check        # prints one status line per check; never prints a token
```

**3. Service-account token** 🧑 (for *syncing* dashboards / alerts / datasource)
1. Open the stack's Grafana (`GRAFANA_URL`) → **Administration → Users and access → Service accounts** → *Add service account*.
2. Name `observability-sync`, role **Admin** (it must write dashboards, datasources and alert provisioning; Editor is not enough for the last two).
3. *Add service account token* → copy it once → `GRAFANA_SA_TOKEN` (prefix `glsa_`). Plan to **revoke it after the first successful sync** and recreate it only when you need to re-sync.

---

## Part 2: Supabase (step 3 from your list, expanded)

**4. Back up and review** 🧑
1. Supabase dashboard → *Database → Backups* (take a manual backup or confirm a recent one).
2. Read `db/migrations/0010_observability.sql`. It only creates the `observability` schema (4 tables), a `NOLOGIN` role `grafana_ro` with SELECT, and revokes from `anon` / `authenticated`. It changes nothing in existing schemas.

**5. Check what is already applied** 🧑 (important)
`python -m db.migrate` applies **every pending** migration, not just 0010. Run in the Supabase SQL editor:
```sql
select version, applied_at from data_pipeline_log.schema_migrations order by version;
```
- Expect `0001`…`0009` already there. If `0009_auth` is *not*, it will also run (creates `citext`, adds columns to `screener_app.users`): decide that on purpose.
- If the query errors with "relation does not exist", migrations have never been applied to this database: stop and tell me.

**6. Apply 0010** 🧑 (🤖 can run it if you ask; it writes to your database, so I will confirm first)
```bash
cd ~/Downloads/trading-agent && source .venv/bin/activate
python -m db.migrate --smoke      # prints "select 1 -> 1" (uses SUPABASE_DB_URL from .env)
python -m db.migrate              # prints: applied: ['0010_observability']
```

**7. Give `grafana_ro` a password** 🧑 (Supabase SQL editor; choose a long random one)
```sql
alter role grafana_ro login password '<strong-password>';
```
Use it as `GRAFANA_PG_PASSWORD`. Never commit it.

**8. Build the Grafana Postgres connection values** 🧑
- Host: the Supabase **pooler**, `aws-0-<region>.pooler.supabase.com:5432` (Connect → *Session pooler*). Use the pooler, not the direct host: the direct host is IPv6-only on many plans and Grafana Cloud may not reach it.
- User: **`grafana_ro.<project-ref>`** (the pooler needs `user.project_ref`); if the connection test fails with a tenant/user error, this is the first thing to check.
- Database `postgres`. Optionally restrict by IP in Supabase *Database → Network restrictions* (Grafana Cloud IPs are published in its docs).

---

## Part 3: Wire it up and sync (step 4: everything else)

**9. Create the env file** 🧑
```bash
cp observability/.env.example observability/.env      # gitignored (verified)
```
Fill: `GRAFANA_URL`, `GRAFANA_SA_TOKEN`, `GRAFANA_OTLP_INSTANCE_ID`, `GRAFANA_OTLP_TOKEN`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `GRAFANA_PG_HOST/DATABASE/USER/PASSWORD`. Leave `ALERT_WEBHOOK_URL` as the placeholder for now.

**10. Generate the OTLP auth header** 🧑
```bash
python -m observability.cloud headers
# prints: OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic%20<base64>   (a derived secret: do not paste it in chat)
```

**11. Put the app-side variables where the processes run** 🧑 (all gitignored)
Add to the root `.env` **and** `frontend/apps/web/.env.local` (the engine inherits the app's env):
```
OTEL_EXPORTER_OTLP_ENDPOINT=…            # from step 2
OTEL_EXPORTER_OTLP_HEADERS=…             # from step 10
TELEMETRY_DB_URL=<your existing SUPABASE_DB_URL>      # run records; write access, so the normal DB user, not grafana_ro
TELEMETRY_HASH_SALT=<output of: openssl rand -hex 32>
```
The shell/cron that runs `scripts/weekly_selection_run.sh` and the eval scripts needs the same `OTEL_*` variables, or the job gauges print instead of sending.

**11b. Check all credentials** 🧑 — `python -m observability.cloud check` should show four OK lines (OTLP traces / metrics / logs, Grafana API). Fix any FAIL first.

**12. Dry-run the sync** 🧑/🤖 (read-only calls to your stack: discovers datasources; writes nothing)
```bash
python -m observability.cloud sync
```
Expect: the three discovered datasource uids, "6 dashboards, 10 alert rules", contact point, and a "DRY RUN" banner. Any error here is a credentials or URL problem: fix before continuing.

**13. Apply the sync** 🧑 (🤖 only after you explicitly say so: it changes your Grafana)
```bash
python -m observability.cloud sync --apply
```
Creates folder *Prompt Screener*, the *Supabase (runs)* datasource, 6 dashboards, 10 alert rules, and the placeholder webhook contact point. Safe to re-run. Do **not** add `--policies` unless you want it to replace the stack's whole notification routing. Add `--no-postgres` to skip the Supabase datasource.

**14. Revoke the service-account token** 🧑 (or keep it only while iterating).

---

## Part 4: Verify end to end (the checklist in `observability/README.md`)

**15. Run the app and make one trace** 🧑
```bash
cd frontend/apps/web && npm run dev
```
Server log should print `[telemetry] enabled`. In the UI: compile → screen → confirm one prompt.

**16. Check each signal in Grafana → Explore** 🧑
- **Tempo:** `{ name = "prompt.run" }` → one trace with `prompt.compile`, `prompt.screen`, `prompt.confirm`, `interpreter.parse`, and engine spans (`screen.filter`, `data.fetch`).
- **Prometheus:** `llm_requests_total`, `prompt_run_duration_seconds_bucket`, `tool_calls_total` (confirms the OTel→Prometheus naming the dashboards assume).
- **Loki:** `{service_name="prompt-screener-web"} | event="end"` (and check `detected_level` exists: the Errors panel uses it).
- **Dashboards → Prompt Screener:** LLM health, Prompt pipeline, Run explorer (pick the prompt id; tasks/agent/tool tables with trace links). If tables error, test the *Supabase (runs)* datasource (Connections → Data sources → Test).

**17. Weekly-job gauges** 🧑
```bash
python -m scripts.emit_job_metrics --dry-run        # shows what would be sent
python -m scripts.emit_job_metrics                  # sends over OTLP (needs the OTEL_* env)
```
Then in Explore: `last_over_time(screener_job_last_success_timestamp[30d])`. The *Screener jobs & data* dashboard should fill in.

**18. Eval gauge (optional)** 🧑
`cd frontend/apps/web && OLLAMA_API_KEY=… OLLAMA_MODEL=gemma4:31b npx tsx scripts/eval-llm-parity.ts` sends `golden_suite_accuracy` → *Interpreter quality* dashboard.

**19. Test an alert** 🧑
Use a throwaway receiver URL (e.g. a request-bin URL) as `ALERT_WEBHOOK_URL`, re-run step 13, then lower one rule's threshold in the Grafana UI to force it to fire and confirm the POST arrives. Choose the real channel (email / Telegram / Slack) later (decision D3).

---

## Troubleshooting (what I expect to go wrong first)
| Symptom | Likely cause / fix |
|---|---|
| No data anywhere, no errors | `OTEL_EXPORTER_OTLP_*` not set in the process that ran (Next server, engine, job shell); `[telemetry] enabled` missing in the server log |
| 401 / 403 from the OTLP gateway | wrong instance ID or token scopes; regenerate with traces/metrics/logs write; re-run `headers` |
| Metrics exist under different names | OTel→Prometheus naming differs: tell me the names, I adjust `build.py` and `metrics-catalog.json` |
| Errors panel (Loki) empty | label is not `detected_level`; tell me what Explore shows and I adjust the query |
| Run explorer tables error | `grafana_ro` password / `user.project_ref` / pooler host; or migration 0010 not applied; or Supabase network restrictions |
| `sync` 403 on alert rules or datasources | service account is not Admin |
| `weekly run missed` alert firing immediately | a job has never reported (no-data alerts by design): run step 17 once |

## What Claude will not do without being asked
Create accounts or tokens, read or print any secret, apply migration 0010, run `sync --apply`, or touch your notification policy.
