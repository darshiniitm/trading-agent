# trading-agent — Claude Code entry point

## What this project is

A weekly **VStop(10,2) + RSI(14)** screener over an NSE mid-cap universe
(₹10,000–50,000cr market cap), plus a walk-forward backtest harness and a live
forward-testing program. This is a **research/POC project**, not a live-trading
system: the locked, a-priori parameters in `config/rules.yaml` produced a
**negative-expectancy** result over a 104-week walk-forward (-1.07%/trade,
Sharpe -2.6, max drawdown -50% — see `README.md`). Do not present backtest
numbers as tradeable without repeating that caveat.

The project's current live focus is a **Test-vs-Control forward-testing
program**: the strategy in `config/rules.yaml` stays frozen ("Control"), and
new ideas (T1/T2/T3 "Test arms") are layered on top in shadow mode, graded
against Control every week, and only allowed to touch real capital after
clearing a pre-registered statistical gate. See
`docs/forward-test-response-and-volume-plan.md` (v0.7) for the full design.

## Read first

**Before making any change to `src/`, `tests/`, `config/`, or
`docs/forward-test-*`, read [`.claude/HARNESS.md`](.claude/HARNESS.md).** It
holds the rules that keep Control frozen, keep the backtest/forward-test
honest (no look-ahead, immutable records), and list the known defects you
should not build on top of uncritically. These rules are enforced by tests
and by code (e.g. `record()` refuses to overwrite a file) — violating them
silently breaks the evidence the whole project is trying to accumulate.

For term/formula lookups (what is VStop, RSI, R-multiple, `candidate_score`,
a "Test arm"), see [`.claude/GLOSSARY.md`](.claude/GLOSSARY.md) rather than
re-deriving them from code each time.

## Architecture map

| Stage | File |
|---|---|
| Strategy spec (frozen "Control") | `config/rules.yaml` |
| Load spec | `src/config.py` |
| Data (no API keys; yfinance + NSE archive CSVs) | `src/data/adapter.py` (see `KNOWN_CAVEATS`) |
| Indicators | `src/indicators/vstop.py`, `src/indicators/rsi.py`, `src/indicators/sector_rs.py` |
| **Single shared screening funnel** | `src/screen/engine.py:run_screen()` — used by both the live screen and every backtest fold |
| Trade construction (EP/SL/target/confidence) | `src/trade/builder.py:build_trades()` |
| Shadow candidate scoring (T1, unvalidated) | `src/screen/candidate_score.py` |
| Daily-resolution rule spec for T1 | `src/screen/daily_scale.py` |
| Backtest / walk-forward / bootstrap CI | `src/backtest/harness.py` |
| Live forward-test record/grade cadence | `tests/track_forward.py` |
| Weekly feature-flag condition matrix + T4 shadow arm registry | `config/feature_flags.yaml`, `src/flags/` (`registry.py`, `rules.py`, `matrix.py`, `grade.py`, `t4.py`, `scorecard.py`, `checks.py`, `audit.py`, `findings.py`, `timing.py`) |
| Flag matrix CLI (record/grade/replay/scorecard/audit — chained off Control's own record, never its own schedule) | `tests/track_flags.py` |
| Console/CSV reporting | `src/report/report.py` |
| One-off CLI entry points | `scripts/run_screen.py`, `scripts/run_backtest.py`, `scripts/rsi_param_study.py`, `scripts/survivorship_check.py`, `scripts/common.py` (shared bootstrap), `scripts/weekly_selection_run.sh` (Control record → flag trigger → audit, chained) |

## Where the docs live

- `docs/forward-test-response-and-volume-plan.md` (v0.7) — the live plan: Control vs. Test-arm design, graduation gates, "what not to do" guardrails, the pre-open recording deadline. §3.9 registers T4 (flag-count selection).
- `docs/feature-flag-matrix-plan.md` (v1.0) — full spec for the weekly feature-flag condition matrix and T4: registry, pipeline stages, invariants, CLI, audit tools, phase plan.
- `docs/forward_test_findings.md` — append-only findings log. Never edit a past entry retroactively.
- `docs/dashboards/test-vs-control-ledger.html` — a **hand-maintained** static dashboard, meant to be rebuilt after every grade run. No generator script exists yet (see the `rebuild-test-control-dashboard` skill).

## Skills available

Native Claude Code skills under `.claude/skills/` — invoke by asking for the task, or by name:

- **`stock-score-lookup`** — ad-hoc scoring/checking of one or a few tickers, any time.
- **`weekly-forward-test`** — the weekly Control(+T1) record/grade cycle.
- **`weekly-flag-matrix`** — the weekly feature-flag condition matrix + T4 shadow arm cycle, chained off `weekly-forward-test`'s own record step.
- **`rebuild-test-control-dashboard`** — regenerate the ledger HTML after a grade run.
- **`run-screen-or-backtest`** — one-off live screen or walk-forward backtest.
- **`add-test-arm`** — propose/build a new T-series shadow experiment.

The `flag-run-auditor` agent (`.claude/agents/flag-run-auditor.md`) is a deterministic,
Bash-only operator invoked by `scripts/weekly_selection_run.sh` / the `weekly-flag-matrix`
skill after each flag record — it relays fixed tool output, it never computes or judges a
number itself.

Your own evolving, personalization-focused skills and agents (dashboard styling, insight tone,
score-mechanism experiments) live separately under `.claude/personal-skills/` and
`.claude/personal-agents/` — see their READMEs. They must never override a `HARNESS.md` rule;
they only change presentation/interpretation, not the underlying computation.

## Current in-flight state (as of writing)

`src/screen/candidate_score.py`, `tests/test_candidate_score.py`, and modifications to
`tests/track_forward.py`, `docs/forward-test-response-and-volume-plan.md`, and the dashboard
HTML are **uncommitted but already on disk** — treat them as current code, not a future change.

The feature-flag condition matrix + T4 (`docs/feature-flag-matrix-plan.md`, Phases 1-5) is
implemented and **uncommitted but already on disk**: `config/feature_flags.yaml`, `src/flags/`,
`tests/track_flags.py`, the T-01..T-16 test suite, `scripts/weekly_selection_run.sh`, the
`weekly-flag-matrix` skill, and the `flag-run-auditor` agent. One real record exists
(`results/feature_flags/flags_2026-09-07.csv`, mode `late_backfill`, all invariants pass). T4's
DEV/VALIDATE calibration (104-week replay) hit kill criterion (a) — `config/feature_flags.yaml`'s
`t4.k` stays `null`; see the 2026-09-15 entry in `docs/forward_test_findings.md`. The matrix
itself keeps recording/grading every week regardless of T4's status.
