#!/bin/sh
# Point the engine's relative data paths (data_cache/, data_cache_literal/, results/) at the persistent volume,
# so nothing stateful lives in the image and the engine code keeps resolving paths exactly as it does locally.
set -eu

DATA_DIR="${ENGINE_DATA_DIR:-/data}"

if [ ! -d "$DATA_DIR" ]; then
  echo "engine-entrypoint: $DATA_DIR does not exist; mount the data volume there (or set ENGINE_DATA_DIR)" >&2
  exit 1
fi

for name in data_cache data_cache_literal results; do
  mkdir -p "$DATA_DIR/$name"
  # replace whatever the image has at /app/$name (nothing, normally) with a link into the volume
  rm -rf "/app/$name"
  ln -s "$DATA_DIR/$name" "/app/$name"
done
mkdir -p "$DATA_DIR/results/prompt_arms"

if [ -z "${ENGINE_TOKEN:-}" ]; then
  echo "engine-entrypoint: WARNING ENGINE_TOKEN is not set; the engine will accept unauthenticated requests" >&2
fi

exec "$@"
