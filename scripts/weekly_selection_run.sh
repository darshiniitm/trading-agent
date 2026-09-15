#!/usr/bin/env bash
# Weekly stock-selection run. Control selection first, flag matrix chained after it.
# See docs/feature-flag-matrix-plan.md §11.4 -- there is no separate schedule for the
# flag pipeline; it only runs as a chained step of the run that picks stocks for trading.
set -euo pipefail
cd "$(dirname "$0")/.."
source .venv/bin/activate

# 0. Refuse to select on a partial week (newest bar must belong to a closed week -- G4)
python -m tests.track_flags preflight --as-of auto

# 1. Grade last week (each step is idempotent / short-circuits if already graded)
for f in results/forward_test/picks_*.json; do
  case "$f" in *_t1.json) python -m tests.track_forward t1grade "$f" || true ;;
               *)         python -m tests.track_forward grade   "$f" || true ;; esac
done
python -m tests.track_flags grade --all-pending || true

# 2. Select this week (Control + T1). record() refuses to overwrite -- that is fine.
python -m tests.track_forward record
python -m tests.track_forward t1 || true

# 3. FLAG TRIGGER -- same week as the picks file just written/found
PICKS=$(ls -1 results/forward_test/picks_*.json | grep -v '_t1\.json$' | sort | tail -1)
STATUS=0
python -m tests.track_flags on-selection --picks "$PICKS" || STATUS=$?

# 4. Audit (read-only agent); never blocks the selection output
WK=$(python -c "import json,sys;print(json.load(open(sys.argv[1]))['signal_week_start'])" "$PICKS")
claude -p "Invoke the flag-run-auditor agent for WK=$WK. Follow its decision table exactly." \
  --allowedTools "Bash(python -m tests.track_flags audit:*),Bash(python -m tests.track_flags findings-draft:*),Bash(python -m tests.track_flags findings-append:*)" \
  >> results/feature_flags/claude_audit.log 2>&1 \
  || python -m tests.track_flags audit --as-of "$WK" --format md >> results/feature_flags/claude_audit.log 2>&1 || true
# The fallback line runs the same deterministic tool if Claude is unavailable, so the
# audit never depends on the LLM being reachable.
exit $STATUS
