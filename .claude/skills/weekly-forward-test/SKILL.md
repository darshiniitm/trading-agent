---
name: weekly-forward-test
description: Run the weekly Control (and T1 shadow) forward-test record and grade cycle via tests/track_forward.py — the pre-open recording rule and record immutability apply here.
---

# Weekly forward test

The operational cadence that keeps this project's evidence honest: record before the outcome is
known, grade once it is, never touch a past record.

## Procedure

1. **Timing check first.** Confirm whether it is currently before Monday's market open (IST)
   for the week that just completed. If it's already past that open and the week is unrecorded,
   say so explicitly rather than silently recording it late — per v0.7 §5, a pick logged after
   Monday's open is not a forward test.
2. **Record Control**: `python -m tests.track_forward record` (equivalently, call `record()`).
   This snapshots `run_screen()` + `build_trades()` output as of the latest completed Friday into
   `results/forward_test/picks_<date>.json` (+CSV). **It will refuse to run if that file already
   exists — do not delete an existing file to force a re-run.**
2b. **Threshold experiment record**: `python -m tests.track_threshold record --picks
   results/forward_test/picks_<date>.json` — splits this week's survivors into SELECTED/REJECTED
   for every risk-cap arm (see the `threshold-experiment` skill). Shadow only.
3. **Record T1 shadow, if due**: `python -m tests.track_forward t1` (`record_t1_shadow()`) — the
   daily rolling-window scan against `src/screen/daily_scale.py:daily_rule_spec()`.
4. **Grade the prior week's record**, once the following week's bar exists:
   `python -m tests.track_forward grade results/forward_test/picks_<date>.json`. This applies the
   gap-stop-aware exit rule and computes basket / T2 / T3 / shadow / near-miss net % into the
   `graded` field. It's idempotent — safe to re-run, it short-circuits if already graded.
4b. **Grade the threshold experiment** once step 4 has filled Control's `graded` block:
   `python -m tests.track_threshold grade --all-pending`.
5. **Grade T1 similarly**: `python -m tests.track_forward t1grade
   results/forward_test/picks_<date>_t1.json`.
6. **Periodically, run the diagnostic pack**: `python -m tests.track_forward summary` —
   aggregates all graded records, bootstrap CIs, rank-IC, and reports against the
   `FIRST_LOOK_WEEKS=13` / `REAL_READ_WEEKS=26` maturity thresholds.
7. **Log anything noteworthy** (a surprising win/loss, a defect firing, a gate cleared or
   missed) as a new dated entry in `docs/forward_test_findings.md` — append only, never edit a
   past entry.
8. **Flag matrix trigger**: immediately after step 2's `record`,  run
   `python -m tests.track_flags on-selection --picks results/forward_test/picks_<date>.json`.
   This is the *only* place the weekly feature-flag condition matrix / T4 shadow arm runs — it
   has no schedule of its own, it only chains off this exact `as_of` (see the
   `weekly-flag-matrix` skill for the full procedure, and
   `docs/feature-flag-matrix-plan.md` for the spec). `scripts/weekly_selection_run.sh` already
   runs steps 2-8 (including 2b and 4b) in the right order end to end if you'd rather invoke the whole chain at once.
9. **After grading, hand off to `rebuild-test-control-dashboard`** to keep the ledger in sync.

## Known data issue when grading (D7)

If the holding week's **Monday was an NSE holiday**, yfinance's weekly bar uses the previous
Friday's close as the week's open, so `grade` books EP = signal close instead of the first real
session's open. Mon 14 Sep 2026 was one (holding week of the 2026-09-07 record). Until Dharmin
decides on a fix, say this explicitly when reporting that week's grade — don't present the EP as a
real fill.

## Guardrails (from `.claude/HARNESS.md`)

- **Pre-open recording rule** — record before the week's market opens, or it isn't a forward
  test.
- **Immutable record** — never delete or hand-edit a `picks_*.json`; `record()` already refuses
  to overwrite one.
- **Gap-stop-aware grading** — a gapped-through stop must fill at the open, not silently at SL.
- **Don't judge Control or any Test arm on one week** — accumulate, don't react.
