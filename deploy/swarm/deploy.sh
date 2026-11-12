#!/usr/bin/env bash
# Build the images on this VM and (re)deploy the stack. Run from the checkout at /srv/screener/repo:
#   ./deploy/swarm/deploy.sh [sha|branch]     (default: main)
# docs/engine-swarm-deploy-plan.md §4.6. Never prints secret values.
set -euo pipefail

REF="${1:-main}"
STACK_ENV="${STACK_ENV:-/srv/screener/stack.env}"
cd "$(dirname "$0")/../.."

git fetch --all --prune
git checkout "$REF"
# a branch name should track its remote tip; a sha is already exact
git rev-parse --verify -q "origin/$REF" >/dev/null && git merge --ff-only "origin/$REF"
GIT_SHA="$(git rev-parse --short HEAD)"
export GIT_SHA
export ENGINE_IMAGE="screener-engine:$GIT_SHA" JOBS_IMAGE="screener-jobs:$GIT_SHA"

[ -f "$STACK_ENV" ] || { echo "missing $STACK_ENV (see deploy/swarm/stack.env.example)" >&2; exit 1; }
set -a
# shellcheck source=/dev/null
. "$STACK_ENV"
set +a
: "${ENGINE_DOMAIN:?set in $STACK_ENV}" "${ACME_EMAIL:?set in $STACK_ENV}" "${OTEL_EXPORTER_OTLP_ENDPOINT:?set in $STACK_ENV}"

echo "== building screener-engine:$GIT_SHA and screener-jobs:$GIT_SHA"
docker build -f Dockerfile.engine --build-arg "GIT_SHA=$GIT_SHA" -t "screener-engine:$GIT_SHA" .
docker build -f Dockerfile.jobs   --build-arg "GIT_SHA=$GIT_SHA" -t "screener-jobs:$GIT_SHA" .

CADDYFILE_HASH="$(sha256sum deploy/swarm/Caddyfile | cut -c1-12)"
export CADDYFILE_HASH

echo "== docker stack deploy (engine updates stop-first: expect a short outage while it warms up)"
docker stack deploy -c deploy/swarm/stack.yml --prune --resolve-image never screener

echo "== waiting for the engine to report $GIT_SHA (up to 10 min)"
ok=0
for _ in $(seq 1 60); do
  body="$(curl -fsS --max-time 8 "https://$ENGINE_DOMAIN/health" 2>/dev/null || true)"
  if [ -n "$body" ] && printf '%s' "$body" | grep -q "\"engine_git_sha\":[[:space:]]*\"$GIT_SHA\""; then ok=1; break; fi
  sleep 10
done
docker service ps screener_engine --no-trunc --format 'table {{.Name}}\t{{.CurrentState}}\t{{.Error}}' | head -5
if [ "$ok" -ne 1 ]; then
  echo "engine did not report $GIT_SHA in time; Swarm may have rolled back (docker service ps screener_engine)" >&2
  exit 1
fi
printf '%s' "$body" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("engine_git_sha:", d.get("engine_git_sha")); print("warm.state:", d.get("warm",{}).get("state"))'

echo "== pruning old images (keeping the newest 3 tags of each)"
for repo in screener-engine screener-jobs; do
  docker image ls "$repo" --format '{{.CreatedAt}}|{{.Repository}}:{{.Tag}}' | sort -r | cut -d'|' -f2 | tail -n +4 \
    | xargs -r docker image rm || true
done
echo "deployed $GIT_SHA"
