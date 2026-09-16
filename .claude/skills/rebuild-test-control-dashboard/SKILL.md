---
name: rebuild-test-control-dashboard
description: Regenerate docs/dashboards/test-vs-control-ledger.html from the latest graded forward-test records after a grade run.
---

# Rebuild the Test-vs-Control ledger dashboard

The dashboard is described in the plan doc as a companion artifact "rebuilt after each grade" —
treat it as generated from data, not a hand-authored page you patch numbers into.

## Procedure

1. **Confirm the latest week has actually been graded** (`tests/track_forward.py:grade()` /
   `grade_t1()` has run for it) before rebuilding — this skill consumes graded output, it doesn't
   grade.
2. **There is currently no generator script.** `docs/dashboards/test-vs-control-ledger.html` is
   hand-maintained HTML — check `src/report/` and `scripts/` again in case one has been added
   since this was written, but as of now there isn't one. If you find yourself hand-editing the
   same sections repeatedly, flag to the user that a small generator script (reading
   `results/forward_test/diagnostic_summary.csv` + per-record `graded` blocks) would remove the
   copy-paste risk — don't build one unprompted, since it's a scope decision beyond "rebuild the
   dashboard."
3. **Source the numbers from**: `results/forward_test/diagnostic_summary.csv` (from `summary()`)
   and each graded record's `graded` block — `basket_net_pct`, `shadow_basket_net_pct`,
   `T2_basket_net_pct`, `T3_basket_net_pct`, `near_miss_basket_net_pct`. Don't recompute these by
   hand from raw picks; read them from the already-graded output so the dashboard can't drift
   from what `track_forward.py` actually computed.
3b. **Feature-flag matrix + T4 data sources** (`docs/feature-flag-matrix-plan.md`): per-flag lift/
   rank-IC comes from `results/feature_flags/scorecard_<date>_forward.csv` and
   `scorecard_latest.md` (`tests/track_flags.py scorecard --mode forward`) — never the `replay`
   variants, which are dev evidence only. T4's own paired series is
   `results/feature_flags/t4_vs_control.csv` once `config/feature_flags.yaml`'s `t4.k` is frozen;
   while `t4.k` is `null`, show T4 as "not yet calibrated / retired" (check
   `docs/forward_test_findings.md` for the dated DEV/VALIDATE entry that explains which) rather
   than an empty series. Same maturity rule as Control's own Test arms: don't visually imply a
   read before `FIRST_LOOK_WEEKS=13` forward weeks.
3c. **Threshold experiment section (§04d) has its own generator** —
   `python -m scripts.rebuild_threshold_dashboard_section` regenerates it from the latest graded
   `results/threshold_experiment/threshold_<wk>.json` (per-arm SELECTED/REJECTED basket returns,
   arm membership, per-survivor grade), writing only between the `THRESHOLD_SECTION:BEGIN`/`END`
   markers around §04d. Run it after `track_threshold grade --all-pending`; it's a safe no-op if
   the latest record isn't graded yet. **Never hand-edit §04d** — regenerate it instead, or the
   next run overwrites the hand edit anyway. For anything the generator doesn't cover yet
   (multi-week aggregate charts, `weeks_differing_from_control`, the 13/26-week read points),
   source numbers from `summary_latest.md` / `summary_<date>_forward.csv`
   (`python -m tests.track_threshold summary`) and add them by hand outside the marker block;
   exclude `late_backfill` weeks from any cumulative line and don't imply a read before 13
   forward weeks.
4. **Preserve the existing visual system** — the current dashboard uses CSS custom properties
   for its light/dark theme (`--gain`/`--loss`/`--flag`-style tokens) and IBM Plex/Newsreader
   fonts. Match it rather than introducing a new style per rebuild.
5. **Keep Control and Test-arm series visually distinct** — never merge them into one blended
   number; the whole point of the Test-vs-Control design is a parallel, labeled comparison.

## Guardrails (from `.claude/HARNESS.md`)

- **Only graded data** — never present an in-flight/ungraded `picks_*.json` as if it were a
  result.
- **Known data caveats** apply to any derived number shown (survivorship bias, no PIT shares
  outstanding — see `.claude/GLOSSARY.md` / `adapter.KNOWN_CAVEATS`).
