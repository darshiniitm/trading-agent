---
name: threshold-experiment
description: Record, grade, or summarise the weekly risk-cap threshold experiment (threshold-experiment_15/17.5/20/22.5/25/30/40/50) via tests/track_threshold.py — shadow arms derived only from Control's picks file.
---

# Threshold experiment (risk-cap sweep)

Tracks, every week, what Control's basket would have returned if `build_trades()`'s risk cap
(`trade.max_r_pct`, Control = 15%) were 15, 17.5, 20, 22.5, 25, 30, 40 or 50%. Each arm splits
Control's own survivors into **SELECTED** (`R/EP ≤ cap`) and **REJECTED** (`R/EP > cap`) and
reports the equal-weight net return of each. Spec: `docs/threshold-experiment-plan.md`;
registration: plan doc §3.10; registry: `config/threshold_experiment.yaml`.

## Procedure

1. **Timing check.** Same rule as `weekly-forward-test`: a record only counts as `forward` if both
   Control's `picks_<wk>.json` and the threshold record exist before the holding week's Monday
   09:15 IST. If it's already past that, say so; the record will be labelled `late_backfill`.
2. **Record** — only after Control's `python -m tests.track_forward record` has written this
   week's picks file:
   `python -m tests.track_threshold record --picks results/forward_test/picks_<wk>.json`.
   Refuses to overwrite. Check X1–X3 print PASS; X1 failing means the arm rule no longer mirrors
   `build_trades()` — stop and investigate, don't delete the record.
3. **Grade** — only after `python -m tests.track_forward grade picks_<wk>.json` has filled
   Control's `graded` block: `python -m tests.track_threshold grade --all-pending`.
   Idempotent. Check X4–X6 PASS.
4. **Summary** — `python -m tests.track_threshold summary` (forward weeks only; `--mode all`
   adds `late_backfill` for context). Writes `results/threshold_experiment/summary_latest.md`.
   Report `weeks_differing_from_control` next to every arm: `_30/_40/_50` are expected to match
   "no cap" almost every week, since a survivor's R% equals `200·ATR/close` and has never
   exceeded ~28%.
5. **Status** — `python -m tests.track_threshold status` lists records, modes, graded state
   and any failed checks.
6. **Dashboard §04d** — `python -m scripts.rebuild_threshold_dashboard_section` regenerates the
   threshold-experiment section of `docs/dashboards/test-vs-control-ledger.html` (arm membership,
   per-arm SELECTED/REJECTED basket returns, per-survivor grade) from the latest graded
   `threshold_<wk>.json`. It only touches the block between the `THRESHOLD_SECTION:BEGIN`/`END`
   markers and is a safe no-op (prints why, exits 0, leaves the file untouched) if that record
   isn't graded yet. Never hand-edit §04d directly — the markers say so.
7. **Log anything noteworthy** (a failed check, a week where a loose arm's worst trade is severe,
   the 13- and 26-week read points) as a new dated entry in `docs/forward_test_findings.md`.

`scripts/weekly_selection_run.sh` already runs steps 2, 3 and 6 in order, keyed off the same picks
file as the flag trigger.

## Known data issue (D7)

Arms are graded from Control's own grade, so they inherit HARNESS §7 D7: in a holding week whose
Monday is an NSE holiday (e.g. Mon 14 Sep 2026, the 2026-09-07 record), EP is the signal-week close,
not a real fill. Say so when reporting that week.

## Guardrails (from `.claude/HARNESS.md`)

- **Control stays at 15%.** Never edit `config/rules.yaml` from this skill. A graduating arm is a
  proposal for Dharmin to decide explicitly, not an automatic change.
- **Derived only from Control's record** (HARNESS §12) — never call `run_screen()`,
  `build_trades()` or read prices to build or grade an arm.
- **Immutable records** — never delete or hand-edit `threshold_<wk>.json`; `record()` refuses to
  overwrite and the ledger raises on duplicate keys.
- **No early verdicts.** Nothing before 13 forward weeks is a read; the single kill/graduation
  decision per arm is at 26 forward weeks. `late_backfill` weeks never count.
- **Caps are frozen.** Changing the grid means a new experiment name and registration, not an
  edit to `config/threshold_experiment.yaml` (refused after `registry-lock`).
- **Forward only** (decision D5) — no historical replay unless Dharmin asks for one, and then it is
  dev evidence that never enters the gate.
