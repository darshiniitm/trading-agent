# Sourced by entrypoints: every file in /run/secrets becomes an env var of the same name, unless that var is already set.
# Only NAME-shaped files (A-Z, 0-9, _) are exported. Never echo values; keep `set -x` off.
if [ -d /run/secrets ]; then
  for f in /run/secrets/*; do
    [ -f "$f" ] || continue
    n=$(basename "$f")
    case "$n" in *[!A-Z0-9_]*) continue ;; esac
    eval "[ -n \"\${$n:-}\" ]" || export "$n=$(cat "$f")"
  done
fi
