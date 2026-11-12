#!/bin/sh
# Weekly jobs: load Swarm secrets into the environment, then run the given command.
set -eu
# shellcheck source=/dev/null
. /usr/local/bin/secrets-env
exec "$@"
