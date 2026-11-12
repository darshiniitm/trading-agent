#!/usr/bin/env bash
# Started by screener-jobs.service (systemd timer). Swarm has no cron, so this scales the replicas:0 `jobs` service to 1,
# waits for its task to finish, saves the log, scales back to 0, and exits non-zero if the task failed.
# docs/engine-swarm-deploy-plan.md §4.7.
set -euo pipefail

SERVICE="${JOBS_SERVICE:-screener_jobs}"
LOG_DIR="${LOG_DIR:-/srv/screener/logs}"
TIMEOUT_S="${JOBS_TIMEOUT_S:-3600}"
mkdir -p "$LOG_DIR"

# Skip when the market is closed (weekend / NSE holiday in config/nse_holidays.yaml). FORCE_RUN=1 overrides, for a re-run.
REPO="${REPO_DIR:-/srv/screener/repo}"
if [ "${FORCE_RUN:-0}" != "1" ] && ! python3 "$REPO/scripts/trading_day_gate.py"; then
  echo "market closed today: weekly jobs skipped"
  exit 0
fi
LOG="$LOG_DIR/jobs-$(date +%F).log"

state() { docker service ps "$SERVICE" --no-trunc --format '{{.CurrentState}}' 2>/dev/null | head -1; }

docker service scale -d "$SERVICE=0"
sleep 5
docker service scale -d "$SERVICE=1"

deadline=$(( $(date +%s) + TIMEOUT_S ))
final=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  s="$(state)"
  case "$s" in
    Complete*|Failed*|Rejected*|Shutdown*) final="$s"; break ;;
  esac
  sleep 15
done

docker service logs --raw --since 2h "$SERVICE" > "$LOG" 2>&1 || true
docker service scale -d "$SERVICE=0"

case "$final" in
  Complete*) echo "weekly jobs completed; log: $LOG" ;;
  "") echo "weekly jobs timed out after ${TIMEOUT_S}s; log: $LOG" >&2; exit 1 ;;
  *) echo "weekly jobs ended as '$final'; log: $LOG" >&2; exit 1 ;;
esac
