# trading-agent — Claude Code entry point

## What this project is

A weekly **VStop(10,2) + RSI(14)** screener over an NSE mid-cap universe
(₹10,000–50,000cr market cap), plus a walk-forward backtest harness and a live
forward-testing program. This is a **research/POC project**, not a live-trading
system: the locked, a-priori parameters in `config/rules.yaml` produced a
**negative-expectancy** result over a 104-week walk-forward (-1.24%/trade,
Sharpe -2.07, max drawdown -70.57% — restated 2026-09-29 after the RSI(14)
seeding fix, see `README.md` and the dated findings entry in
`docs/forward_test_findings.md`; supersedes both the original -1.07%/-2.6/-50%
figures and the 2026-09-16 D1–D6 restatement, -1.285%/Sharpe -2.24). Do not
present backtest numbers as tradeable without repeating that caveat.

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
| Risk-cap threshold experiment (shadow arms `threshold-experiment_15/17.5/20/22.5/25/30/40/50`, derived only from Control's picks file) | `config/threshold_experiment.yaml`, `src/experiments/threshold.py`, `tests/track_threshold.py` (record/grade/summary/status) — spec `docs/threshold-experiment-plan.md` |
| Experiment registry for backtest variants (V2, V3, V4, V7a, V7b, guardrail calibration G) | `config/experiments.yaml`, `src/experiments/registry.py` |
| Week-over-week arm history study (trend Q1, dominant-arm Q2, repetition diagnostics) — read-only over graded records, Lane A/B/C isolated | `src/wow/` (`arms.py`, `panel.py`, `stats.py`, `three_line.py`, `summarise.py`, `diagnostics.py`, `manifest.py`), `tests/track_wow.py` (build/summarise/diagnostics/verify) — spec `docs/wow-arm-history-analysis-plan.md`, outputs `results/wow/` |
| Data segments + read ledger (dev / holdout_ext / forward) | `src/data/segments.py`, `results/evidence/` |
| Daily → weekly resample, 2019+ history | `src/data/resample.py`, `tests/offline.py:env_extended()`, `scripts/backfill_history.py` (needs network) |
| Holiday-week bar correction (D7 fix) | `src/data/holding_week.py:corrected_week_bar()` |
| Literal spec — Dharmin's brief, run literally, parallel to Control | `config/rules_literal.yaml`, `scripts/bootstrap_literal.py`, `tests/track_literal.py` (record/grade/replay + T1-redefined rolling ledger), `tests/offline.py:env_literal()` — spec `docs/literal-spec-plan.md`; frozen old mid-week scan under `midweek_scan_*` (`src/screen/t1_scan.py`, shared with Control's own separate T1) |
| 1-/2-/3-week horizon grading (Literal "Step 5 extended") | `src/backtest/horizons.py` (`grade_horizons()`), maturity loop + replay + weekly report in `tests/track_literal.py` (`maturity_loop()`, `replay_horizons()`, `weekly_report()`), block-bootstrap stats in `src/backtest/stats.py` |
| Console/CSV reporting | `src/report/report.py` |
| One-off CLI entry points | `scripts/run_screen.py`, `scripts/run_backtest.py`, `scripts/rsi_param_study.py`, `scripts/survivorship_check.py`, `scripts/common.py` (shared bootstrap), `scripts/weekly_selection_run.sh` (Control record → flag trigger → audit, chained) |

## Where the docs live

- `docs/forward-test-response-and-volume-plan.md` (v0.7) — the live plan: Control vs. Test-arm design, graduation gates, "what not to do" guardrails, the pre-open recording deadline. §3.9 registers T4 (flag-count selection).
- `docs/feature-flag-matrix-plan.md` (v1.0) — full spec for the weekly feature-flag condition matrix and T4: registry, pipeline stages, invariants, CLI, audit tools, phase plan.
- `docs/threshold-experiment-plan.md` (v1.0) — risk-cap threshold experiment: decisions, registration, invariants X1–X6, rollout. Registered as plan doc §3.10.
- `docs/open-decisions-implementation-plan.md` (v1.0) — extended history, V2/V3/V4 entry & horizon, V7 short diagnostics, guardrail validation; decisions D1–D6 settled 16 Sep 2026.
- `docs/wow-arm-history-analysis-plan.md` (v0.1) — week-over-week arm history study: trend (Q1) and dominant-arm (Q2) questions over every registered arm, on a common week grid, Lane A (flag-matrix replay, primary) / Lane B (V-series dev) / Lane C (live forward, append-only) kept isolated. Findings in `docs/wow_findings.md`.
- `docs/evidence-ledger.md` — which studies have read returns in which window.
- `docs/literal-spec-plan.md` — the Literal series: Dharmin's five-step brief taken literally, the gap-by-gap comparison against Control's interpretation, and decisions 1–9 (universe, RSI band, entry, flip direction, etc.). Registered in the v0.7 plan doc §3.11.
- `docs/forward_test_findings.md` — append-only findings log. Never edit a past entry retroactively.
- `docs/dashboards/test-vs-control-ledger.html` — a **hand-maintained** static dashboard, meant to be rebuilt after every grade run. No generator script exists yet (see the `rebuild-test-control-dashboard` skill).

## Skills available

Native Claude Code skills under `.claude/skills/` — invoke by asking for the task, or by name:

- **`stock-score-lookup`** — ad-hoc scoring/checking of one or a few tickers, any time.
- **`threshold-experiment`** — record/grade/summarise the weekly risk-cap sweep, chained off Control's own record and grade.
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

**15 Sep 2026 — `src/trade/builder.py` change (Dharmin's decision, kept):** the `R <= 0` reject was
removed; `build_trades()` now rejects only `R/EP > trade.max_r_pct`. For live selection this is a
no-op except when close == VStop line exactly (EP is always the signal close, and every survivor is
in an uptrend). It is still a Control-file change: the flag audit's AU03 will flag
`src/trade/builder.py` drift until it is committed. See the 2026-09-15 findings entry.

**15 Sep 2026 — threshold experiment registered and implemented** (uncommitted, on disk):
`config/threshold_experiment.yaml`, `src/experiments/`, `tests/track_threshold.py`,
`tests/test_threshold_experiment.py` (TX-01..TX-09), `scripts/weekly_selection_run.sh` steps,
`threshold-experiment` skill. `results/threshold_experiment/threshold_2026-09-07.json` is the first
record (`late_backfill`). Forward tracking starts with signal week 2026-09-14.

**16 Sep 2026 — open-decisions plan v1.0, Phases 0–2 implemented** (uncommitted, on disk): harness
defects D1/D2/D3/D5/D6 fixed and baseline restated (findings 2026-09-16); `config/experiments.yaml`
registered and locked; `src/data/resample.py`, `src/data/segments.py`, `env_extended()`,
`scripts/backfill_history.py`; tests `test_harness_fixes.py`, `test_data_segments_registry.py`.
D7 (weekly holiday-open defect in graders) was **fixed 2026-09-16** via
`src/data/holding_week.py:corrected_week_bar()` — see `.claude/HARNESS.md` §7 and the
2026-09-16 findings entry; a residual holiday-zero-volume-row case surfaced later (findings
2026-09-14 entry) and is fixed alongside the Literal series below. D4 (RSI flat series) was
**fixed 2026-09-26** — see the dated findings entry and `.claude/HARNESS.md` §7. Not yet
built: V2/V3/V4 engines, V7a/V7b, guardrail calibration (Phases 4–5).

**26–27 Sep 2026 — "Literal" strategy series** (uncommitted, on disk): a second, parallel,
frozen spec that implements Dharmin's original five-step brief exactly (full NSE equity list
as the universe, not the ~500-index proxy; RSI band [50, 65]; entry = signal close; no 15%
risk-cap filter; one confidence score), run alongside Control for comparison rather than as a
graded Test arm. `config/rules_literal.yaml`, `scripts/bootstrap_literal.py` (universe +
weekly-bar cache build), `tests/track_literal.py` (`record()`/`grade()`/`replay()`, immutable
like Control's), `tests/offline.py:env_literal()`. Spec and the gap-by-gap comparison against
Control's interpretation: `docs/literal-spec-plan.md`. Phases 0–4 (verify, universe, qualify,
sectors, trades) are done and tested (`tests/test_literal_spec_wiring.py`); Phase 5 is done as
of 27 Sep 2026: T1 is redefined as a rolling Friday-window loop (no longer the old mid-week
scan) — every graded Literal week feeds a rolling ledger via `tests/track_literal.py`'s
`_ledger_row()`/`_append_rolling_ledger()`, with 4-/13-/26-week aggregate stats from
`rolling_stats()`, read with `python -m tests.track_literal rolling`; `grade()` (live) and
`replay()` (history) build the identical ledger row shape and call the identical
`rolling_stats()`, so the live cadence and replayed history are one code path. The OLD
mid-week scan (`src/screen/t1_scan.py:scan_t1_week()`) is frozen, not deleted, and is no
longer called T1 — kept in `tests/track_literal.py` under `midweek_scan_record()`/
`midweek_scan_grade()`/`midweek_scan_replay()` (Control's own, separate T1 in
`tests/track_forward.py` is untouched). Registered in the v0.7 plan doc §3.11. The first live
pre-open `record()` for Literal has not been run yet (Dharmin's decision — prepare code only,
trigger it manually).

**27 Sep 2026 — "Step 5 extended" built** (uncommitted, on disk): 1-/2-/3-week horizon
grading for every Literal pick, in two views — signal (close-to-close, stop ignored) and
trade (trailing stop, re-computed to each week's own closed VStop line — Dharmin's decision,
27 Sep 2026 — and frozen at its exit price for all later horizons once the stop is hit).
`config/rules_literal.yaml`'s `validation.horizons_weeks: [1, 2, 3]`;
`src/backtest/horizons.py:grade_horizons()` (one function for every horizon/view, reused
identically by the live maturity loop and by replay); `tests/track_literal.py:maturity_loop()`
(append-only, idempotent, writes to `results/literal_test/horizons/<record_id>.jsonl`, never
touches the original `picks_<date>.json`) and `replay_horizons()` (same function, swept over
history from 2024-01-01); `src/backtest/stats.py` (`block_bootstrap_ci`, 3-week blocks, plus
`nonoverlapping_sanity` as a second, independent every-3rd-Friday check, reported side by
side); `tests/track_literal.py:weekly_report()` assembles the doc's 5-step weekly report
purely from already-recorded evidence (no re-screening/re-grading). Leakage covered by
`tests/test_leakage.py::test_grade_horizons_future_mutation_canary`; behavior by
`tests/test_horizons.py`; ledger/idempotency by `tests/test_t1_rolling_window.py` and
`tests/test_maturity_loop.py`. Not yet run: a real historical `replay_horizons()` sweep (needs
the full daily-bar backfill in `data_cache_literal/`, a real, long, network-heavy pull — same
caveat as Literal's own `replay()`).

Control keeps recording for 4–6 weeks alongside Literal for comparison; old
Control-interpretation results (-1.37%/trade, T1/threshold findings) stay in the ledger,
labelled as such — they are not evidence for or against the Literal strategy.
