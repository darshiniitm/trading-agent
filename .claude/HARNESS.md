# Harness rules — read before touching code, config, or forward-test docs

These rules protect the thing this project is actually trying to produce: a clean,
statistically honest read on whether this strategy (or a variant of it) has edge. Most are
already enforced by tests or by code; treat a violation as a bug even where nothing currently
crashes. For term definitions and formulas, see `.claude/GLOSSARY.md` — this doc is rules, not
math.

## 1. Control is frozen

`config/rules.yaml` **is** Control. Its header says so directly: "This file IS the strategy.
Editing it changes what the screen/backtest does." Universe definition, VStop/RSI params,
`trade.max_r_pct`, `trade.confidence.weights` — none of these change casually, on the strength
of one week's forward-test result, or to make a Test arm's numbers look better. A new idea goes
into a Test arm (T1/T2/T3-style, see `add-test-arm` skill) or a shadow score
(`candidate_score.py`-style), never directly into this file. If you're asked to change
`rules.yaml`, treat that as a distinct, deliberate decision the user makes explicitly — not a
side effect of "improving" something else.

## 2. Single shared code path

`src/screen/engine.py:run_screen()` is the **one** funnel used by the live screen and every
backtest fold. Never write a second, parallel implementation of the universe/liquidity/predicate
filtering "just for a quick check" — any divergence between a live path and a backtest path is
exactly the kind of bug that invalidates a backtest. `src/screen/daily_scale.py:daily_rule_spec()`
is the sanctioned pattern for a variant: deep-copy `rule_spec`, scale only the fields that need
to change (T1 scales week-denominated lookbacks by 5 for daily resolution), leave the actual
signal definitions (VStop, RSI band, risk cap) untouched.

## 3. No look-ahead / point-in-time discipline

Every ticker panel must be sliced with `_slice_as_of` (`src/screen/engine.py`) — rows with
`date <= as_of` only — before any indicator is computed. Precomputing an indicator over full
history and slicing afterward, or reading a bar dated after the signal date, reintroduces a
look-ahead bug. `tests/test_leakage.py` is the enforcement probe (its `_corrupt_after`/
`_truncate_after` helpers exist specifically to catch this) — if you touch anything in the
screen/backtest path, re-run it.

## 4. Immutable forward-test record

`tests/track_forward.py:record()` **refuses to overwrite** an existing `picks_<date>.json` —
this is enforced in code, not just convention. Never delete or hand-edit a `picks_*.json` to
"fix" a mistake after the fact. If something was wrong, note it honestly in
`docs/forward_test_findings.md` instead (see rule 6). The whole point of pre-registration is
that the record can't be changed once the outcome is known.

## 5. Time-sensitive recording rule

Per the v0.7 plan §5: **record before the week's market opens.** A pick logged after Monday's
open is not a forward test — it's hindsight. If you're asked to run the weekly record and it's
already past that week's open, say so explicitly rather than silently recording it as if it were
timely.

## 6. Gap-stop-aware grading, append-only findings

`_grade_rows()` in `tests/track_forward.py` fills at the week's open if the market gapped
through the stop, and never silently substitutes the stop price as if that were the fill — a
gapped-through stop is a worse loss than a stop hit intraweek, and the grading must reflect that.
Separately, `docs/forward_test_findings.md` is **append-only**: add a new dated entry after each
`grade` run, never edit a past entry retroactively, even if a later week changes your read of it.

## 7. Known defects — don't build on them uncritically, don't quietly "fix" them mid-task

- **Gap-through-stop mis-fill in `simulate_week_forward`** (`src/backtest/harness.py`) — the
  *backtest* harness (unlike `track_forward.py`'s grading, which already has the honest fix) can
  report a stop-hit exit when the true fill was a worse gapped-open price, inflating historical
  expectancy.
- **Flat/zero-pick weeks silently dropped** from `weekly_portfolio_returns` — should count as a
  zero-return week, not be excluded; excluding them inflates Sharpe.
- **Look-ahead risk in the trend-hold exit path** (`rolling_walk_forward_trend_hold`) — probed by
  `tests/test_leakage.py`.
- **RSI on a flat/constant price series returns 100 instead of 50** (`src/indicators/rsi.py`,
  `avg_loss == 0` edge case) — a neutral series should not read as maximally overbought.
- **`KeyError` risk in sector-RS / `flag_outperforming`** on a zero-survivor week — an empty
  universe/survivor set should not crash the report.

If a change happens to fix one of these, don't just delete the probing test — note it in
`docs/forward_test_findings.md` and confirm `tests/test_backtest_engine.py` / `tests/test_leakage.py`
(the canonical defect-probe tests) still pass and now demonstrate the fix.

## 8. No network access inside tests

Tests must be hermetic. Use `tests/offline.py`'s cached/offline panel pattern; no test should
call `yfinance` or hit the NSE archive live. `OpenSourceAdapter` has no API keys to leak, but a
live network call in a test makes it flaky and non-reproducible.

## 9. Don't widen the universe or loosen predicates to chase trade volume

Explicit v0.7 §4 rule: don't loosen the RSI band or the risk cap, don't widen the universe or
VStop sensitivity, on the strength of one week's read (low trade count, one bad week, one good
week). That kind of change is separately-named future work (the plan doc's "V-series" open
decisions in §6), not something to fold into a Test-arm task or a "quick tweak."

## 10. Statistical gates aren't optional

`bootstrap_ci` (`src/backtest/harness.py`, seed=42, 5000 resamples) and the maturity thresholds
`FIRST_LOOK_WEEKS = 13` / `REAL_READ_WEEKS = 26` (`tests/track_forward.py`) define when a result
is old enough to read at all. Never treat a Test arm as validated (or invalidated) before it
clears its pre-registered gate at the appropriate week count — this generalizes v0.7 §4's
explicit "do not judge T1 on one week" rule to every Test arm, in both directions.

## 11. Known data caveats

`src/data/adapter.py: KNOWN_CAVEATS` — no point-in-time shares outstanding, no delisted tickers
(survivorship bias, biases returns upward), universe is a proxy union of index CSVs rather than
a full point-in-time NSE listing, yfinance's adjustment methodology is unverified. Any finding or
dashboard number derived from this data should carry this caveat, not be presented as clean.
