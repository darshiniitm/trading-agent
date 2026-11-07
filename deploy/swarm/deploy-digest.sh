#!/usr/bin/env bash
# Deploy CI-built images from GHCR by digest (no build on the VM). Run on the VM as the deploy user, from /srv/screener/repo:
#   ./deploy/swarm/deploy-digest.sh <engine-sha256:...> <jobs-sha256:...> <git-sha>
# `make deploy` runs this over IAP SSH. Roll back with `make rollback`.
set -euo pipefail
ENGINE_DIGEST="${1:?engine digest (sha256:...)}"; JOBS_DIGEST="${2:?jobs digest (sha256:...)}"; GIT_SHA="${3:?git sha}"
STACK_ENV="${STACK_ENV:-/srv/screener/stack.env}"
GHCR_REPO="${GHCR_REPO:?set GHCR_REPO (e.g. ghcr.io/<owner>/trading-agent) in $STACK_ENV}"
cd "$(dirname "$0")/../.."
set -a; . "$STACK_ENV"; set +a
: "${GHCR_REPO:?}" "${ENGINE_DOMAIN:?}" "${ACME_EMAIL:?}" "${OTEL_EXPORTER_OTLP_ENDPOINT:?}"
case "$ENGINE_DIGEST$JOBS_DIGEST" in *sha256:*sha256:*) ;; *) echo "digests must look like sha256:<hex>" >&2; exit 2 ;; esac
export GIT_SHA ENGINE_IMAGE="$GHCR_REPO/engine@$ENGINE_DIGEST" JOBS_IMAGE="$GHCR_REPO/jobs@$JOBS_DIGEST"
CADDYFILE_HASH="$(sha256sum deploy/swarm/Caddyfile | cut -c1-12)"; export CADDYFILE_HASH
docker stack deploy -c deploy/swarm/stack.yml --prune --with-registry-auth screener
echo "deployed $GIT_SHA: $ENGINE_IMAGE"
