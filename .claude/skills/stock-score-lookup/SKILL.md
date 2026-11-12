---
name: stock-score-lookup
description: Score, look up, or check one or a few NSE mid-cap tickers on demand, outside the weekly forward-test cadence — VStop/RSI state or a candidate_score for an ad-hoc question.
---

# Stock score lookup

Use this for an ad-hoc question ("what's TICKER's VStop/RSI doing right now", "what would this
stock's candidate_score be", "run a quick screen with a smaller universe") — not for the
recorded weekly cadence (that's the `weekly-forward-test` skill) and not for a full validation
backtest (that's `run-screen-or-backtest`).

## Procedure

1. **Bootstrap the shared environment** — call `scripts/common.py:bootstrap(rule_spec_path,
   ticker_limit=None)`. This loads `rule_spec`, builds the adapter, pulls the universe and
   weekly panels, and fetches shares outstanding. Don't hand-build a parallel data path; reuse
   this.
2. **Full re-screen** (if the ask is "who currently qualifies", or a filtered subset): call
   `src/screen/engine.py:run_screen(as_of, rule_spec, adapter, universe_df, weekly_panels,
   shares_map)` — the same funnel `scripts/run_screen.py` uses. Pass `as_of=None` for the latest
   available Friday, or a specific date.
3. **Single-ticker diagnostic** (if the ask is about one or a few specific names, possibly
   outside the mid-cap band): pull that ticker's panel from `weekly_panels`, PIT-slice it
   (`_slice_as_of` in `engine.py`), and call `compute_vstop`/`compute_rsi` directly. **This
   bypasses the cap-band/liquidity funnel** — present it as a diagnostic reading, not as a
   "survivor" or a screen result.
4. **Candidate score**: to compute `edge_score`/`guardrail_multiplier`/`candidate_score` for a
   row, call `src/screen/candidate_score.py:compute_candidate_score(...)` — the same call
   `record_t1_shadow()` in `tests/track_forward.py` makes. Reuse it rather than reimplementing
   the formula (see `.claude/GLOSSARY.md` for what each field means).
4b. **Risk-cap context**: for a survivor, report `R% = (close − vstop_line)/close × 100` and which
   threshold-experiment arms would SELECT it (`src/experiments/threshold.py:is_selected`) — e.g.
   19.6% is REJECTED by `_15`/`_17.5` and SELECTED from `_20` up. Informational only.
5. **Present results with funnel context** — when relevant, show `FunnelReport` stage counts
   (`run_screen()`'s `funnel` output) so it's clear whether a ticker was excluded by cap band,
   liquidity, or a specific predicate, versus never reaching evaluation at all.

## Guardrails (from `.claude/HARNESS.md`)

- **Read-only / diagnostic only.** Never write to `results/forward_test/picks_*.json` from this
  skill — that's the immutable `record()` path, a different skill (`weekly-forward-test`).
- **No look-ahead** — always PIT-slice (`_slice_as_of`) before computing any indicator.
- **Never touches `config/rules.yaml`.** A finding here is informational; it doesn't change
  Control.
