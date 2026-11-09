#!/usr/bin/env bash
# One-screen status report for the engine stack. Read-only; never prints secret values.
#   ./deploy/swarm/status.sh [hostname]      (hostname defaults to ENGINE_DOMAIN from /srv/screener/stack.env)
set -uo pipefail
STACK_ENV="${STACK_ENV:-/srv/screener/stack.env}"
[ -f "$STACK_ENV" ] && { set -a; . "$STACK_ENV"; set +a; }
HOST="${1:-${ENGINE_DOMAIN:-}}"
hr() { printf '\n== %s\n' "$1"; }

hr "services"
docker service ls --format 'table {{.Name}}\t{{.Replicas}}\t{{.Image}}' 2>&1

hr "engine tasks (newest first; a Failed line above a Running one is history)"
docker service ps screener_engine --no-trunc --format 'table {{.Name}}\t{{.CurrentState}}\t{{.Error}}' 2>&1 | head -6

hr "engine health check (container level)"
cid="$(docker ps -q --filter name=screener_engine | head -1)"
if [ -n "$cid" ]; then
  docker inspect "$cid" --format 'status={{.State.Health.Status}} failing_streak={{.State.Health.FailingStreak}} started={{.State.StartedAt}}' 2>&1
else
  echo "no running engine container"
fi

hr "warm-up (https://$HOST/health)"
if [ -n "$HOST" ]; then
  body="$(curl -sS -m 10 "https://$HOST/health" 2>&1)"
  printf '%s' "$body" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("not JSON / no response:", sys.stdin.read()[:200]); raise SystemExit
w = d.get("warm", {})
print("engine_git_sha :", d.get("engine_git_sha"))
print("last_bar_date  :", d.get("last_bar_date"))
print("state          :", w.get("state"))
ph, idx, n = w.get("phase"), w.get("phase_index"), len(w.get("phases", []))
if ph: print("phase          : %s (%s of %s)" % (ph, (idx or 0) + 1, n))
if w.get("total"): print("progress       : %s / %s (%.0f%%)" % (w.get("done") or 0, w["total"], 100.0 * (w.get("done") or 0) / w["total"]))
print("elapsed        : %ss (this phase %ss)" % (w.get("elapsed_s"), w.get("phase_elapsed_s")))
print("error          :", w.get("error"))
' 2>&1 || echo "$body" | head -c 300
else
  echo "no hostname (set ENGINE_DOMAIN in $STACK_ENV or pass it as an argument)"
fi

hr "auth gate (expect 401 without a token)"
[ -n "$HOST" ] && curl -sS -m 10 -o /dev/null -w "POST /warmup/retry without token -> HTTP %{http_code}\n" -X POST "https://$HOST/warmup/retry" 2>&1

hr "memory / swap / disk"
free -h | head -3
df -h / | tail -1
[ -n "$cid" ] && docker stats --no-stream --format 'engine container: {{.MemUsage}} ({{.MemPerc}}) cpu {{.CPUPerc}}' "$cid"
du -sh /srv/screener/data 2>/dev/null | sed 's/^/data dir        : /'

hr "recent engine log (health-check noise removed)"
docker service logs screener_engine --tail 200 2>&1 | grep -v "GET /health" | tail -12

hr "caddy"
docker service ps screener_caddy --format 'table {{.Name}}\t{{.CurrentState}}' 2>&1 | head -3

hr "secrets present (names only)"
docker secret ls --format '{{.Name}}' 2>&1 | tr '\n' ' '; echo

hr "timers"
systemctl list-timers 'screener-*' --no-pager 2>&1 | head -6
