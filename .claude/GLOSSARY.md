# Glossary — definitions and formula pointers

Plain-English definitions with a pointer to the source of truth in code. This doc does not
re-derive the math — if a formula changes, the code is right and this file's *pointer* stays
right; only inline duplicates go stale. For rules about when/how these get used, see
`.claude/HARNESS.md`.

**VStop(10, 2)** — a volatility-based trailing stop (TradingView's "Volatility Stop" recurrence;
not SuperTrend/Chandelier/PSAR). Tracks a running high/low since the last flip and a candidate
stop at `high - mult*ATR` (uptrend) or `low + mult*ATR` (downtrend); flips direction when price
crosses the candidate stop. `flip_up`/`flip_down` are one-bar transition events, computed weekly
with `length=10`, `mult=2.0` on `close`. Source: `src/indicators/vstop.py`.

**RSI(14), Wilder smoothing** — momentum oscillator, `RSI = 100 - 100/(1+RS)` where `RS` is the
Wilder-smoothed average gain over average loss. Note the flat-series edge case in
`.claude/HARNESS.md` §7 (returns 100, not 50, when `avg_loss == 0`). Source:
`src/indicators/rsi.py`.

**Screener predicate** — a stock is a survivor when, on a given Friday close: `flip_up == True`
AND `50 <= RSI <= 65`, within the mid-cap universe (₹10,000–50,000cr market cap, median 8-week
turnover ≥ ₹10cr). Source: `config/rules.yaml`, applied by `src/screen/engine.py:run_screen()`.

**near_miss** — a stock whose VStop flipped up but that failed a later predicate (typically the
RSI band) — tracked as a real trade the strategy chose not to take, not discarded as noise.
Source: `run_screen()`'s `near_miss` output.

**EP / SL / R / target** — for each survivor: `EP` (entry price) = next week's open, `SL` (stop
loss) = the VStop line, `R = EP - SL`, `target = EP + 2*R`. A trade is rejected if `R <= 0` or
`R/EP > 0.15` (the 15% risk cap — `trade.max_r_pct`). Source: `src/trade/builder.py:build_trades()`.

**confidence** — a 0–1 (scaled to 0–100 internally) weighted composite of `rr` (reward:risk),
`rsi_sweetspot` (triangular kernel peaking at the RSI band's midpoint, 57.5), `sector_rs`,
`trend_quality` (`(close-SL)/ATR`), `volume` (vs. 8-week average), `liquidity`; weights in
`config/rules.yaml: trade.confidence.weights` (rr .25, rsi_sweetspot .15, sector_rs .20,
trend_quality .15, volume .15, liquidity .10). Source: `src/trade/builder.py:build_trades()`.

**edge_score / guardrail_multiplier / candidate_score** — the v1 shadow scoring scheme (v0.7
plan §3.8), shadow-only and unvalidated:
- `edge_score` (0–100) reuses `confidence`'s exact weighted-sum formula, so a Control trade's
  and a T1 candidate's edge_score are directly comparable.
- `guardrail_multiplier` (0–1) is a *product* of three discount factors — risk-cap headroom,
  liquidity multiple, market-cap band centrality — never additively blended into edge_score.
  This gate-or-discount-never-blend rule is the module's central architectural principle.
- `candidate_score = edge_score * guardrail_multiplier`.
Source: `src/screen/candidate_score.py` (see its module docstring for the full rationale).

**daily_rule_spec** — a deep copy of `rule_spec` with only week-denominated lookback fields
(liquidity lookback, sector RS lookbacks) scaled ×5 for daily resolution; VStop/RSI/risk-cap
parameters are untouched. Used by T1's daily rolling scan. Source: `src/screen/daily_scale.py`.

**Control vs. Test arm, shadow mode, graduation gate** — "Control" is the frozen production rule
in `config/rules.yaml`, run through the normal weekly cadence. A "Test arm" (T1 = rolling daily
scan, T2 = fixed-fractional 1%/R position sizing, T3 = confidence-weighted allocation) is a
shadow-only variant that runs in parallel, is graded against Control every week, and is not
allowed to touch real capital until it clears a pre-registered bootstrap-CI gate (excludes zero)
at the `FIRST_LOOK_WEEKS = 13` / `REAL_READ_WEEKS = 26` review points. Source:
`docs/forward-test-response-and-volume-plan.md` §3.1–§3.5, `tests/track_forward.py`
(`record_t1_shadow`, `grade_t1`, `summary`).
