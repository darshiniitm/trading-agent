# Forward-test findings log

Dated notes on graded forward-test weeks (`results/forward_test/`) worth
carrying into future parameter decisions. Appended after each `grade` run,
not edited retroactively. Per the pre-registered prior in
`tests/track_forward.py`: no single week is evidence — this log is for
spotting *patterns that recur*, not for reacting to one good or bad week.

---

## 2026-08-24 signal week (graded 2026-09-06)

Full record: `results/forward_test/picks_2026-08-24.json`

Everything that flipped VStop that week (`vstop_flip: 3`) ended up net
positive or beat the benchmark — including one name the RSI(50–65) band
filter screened out entirely:

| Ticker | Status | Why | Net return |
|---|---|---|---|
| ENGINERSIN.NS | TRADE | RSI 60.5 — in band | **+9.74%** |
| NSLNISP.NS | shadow — rejected by 15% risk cap | RSI 60.0 — in band | **-4.97%** |
| IFCI.NS | never a survivor — RSI 67.9, above the 65 ceiling | filtered at RSI step | **+12.77%** |

Benchmark (NIFTYMIDCAP150) that week: **-1.31%**.

**Observation:** the RSI band's upper bound (65) excluded IFCI, which was
this week's biggest winner — "too overbought" turned out to be a false
negative here. The risk cap, on the other hand, correctly kept the basket
out of NSLNISP, the one loser. One week can't tell us whether the RSI
ceiling is systematically too tight or this was a fluke — that requires
accumulating near-miss outcomes over many weeks.

**Actionability:** `tests/track_forward.py` (`record`/`grade`) and
`src/screen/engine.py`'s `run_screen()` now automatically capture and grade
every VStop-flip "near-miss" (a candidate that fired the trend signal but
was filtered by a later condition, not just risk-cap-rejected survivors) as
part of every future forward-test record — see `near_miss` in the JSON and
`graded.near_miss_basket_net_pct` in the summary. Once enough weeks have
accumulated, `scripts/rsi_param_study.py`-style analysis on the near-miss
population (specifically: RSI > 65 rejects) would answer whether the upper
band bound is costing more than it saves.

---

## 2026-09-15 — T4 (flag-count selection) DEV/VALIDATE calibration, and a known
## partial-week risk in Control's own record() (§14 of docs/feature-flag-matrix-plan.md)

**T4 K-selection protocol (`docs/feature-flag-matrix-plan.md` §7.3), run via
`python -m tests.track_flags t4-calibrate` against a 104-week replay
(2024-09-09 .. 2026-08-31, `results/feature_flags/replay/`):**

- DEV (older 52 weeks, 2024-09-09..2025-09-01): K=11 excluded (coverage
  38.5% < the 60% minimum). Among K∈{7,8,9,10}, K=10 had the least-negative
  mean weekly net (-0.5754%), so K=10 was chosen (ties would have gone to
  the larger K; no tie here).
- VALIDATE (newer 52 weeks, 2025-09-08..2026-08-31), K=10 run once:
  **mean weekly net = -0.0202%**, coverage 92.3%.
- **Kill criterion (a) triggered**: VALIDATE mean weekly net ≤ 0. Per
  `docs/feature-flag-matrix-plan.md` §7 / plan-doc §3.9's kill-criteria
  table, **T4 is retired before forward start** — `config/feature_flags.yaml`'s
  `t4.k` stays `null` (never frozen for this registry version); the flag
  matrix itself (registry v1, 13 flags) continues to record and grade every
  week regardless, since the matrix and T4 are separately registered per
  §1's "T4 ... on top of" framing.
- Caveat (§7.3 step 5, `.claude/HARNESS.md` §11 `KNOWN_CAVEATS`): this
  104-week window overlaps the window already used by Control's own
  walk-forward, and the universe carries survivorship bias (no delisted
  tickers). This is dev evidence for a kill decision, not a clean backtest —
  consistent with the project's existing negative-expectancy read on Control
  itself (see `README.md`).
- This is a real negative result, not a bug to route around: no threshold
  was loosened and no K outside `k_grid: [7,8,9,10,11]` was tried to make
  the VALIDATE number positive, per §8.4's "never change a threshold because
  a scorecard looked bad" rule and `.claude/HARNESS.md` §9.

**Known issue logged, not fixed (per `docs/feature-flag-matrix-plan.md` §14,
and `.claude/HARNESS.md`'s "don't change Control's cadence mid-task"
spirit):** `tests/track_forward.py`'s `record()` and `record_t1_shadow()`
both resolve `as_of = all_dates(panels)[-1]`. If the local weekly-bar cache
is refreshed mid-week, yfinance can return an in-progress, Monday-dated bar
for the *current* week, and that partial bar would silently become `as_of`
— a partial-week signal recorded as if it were a completed Friday close.
The flag pipeline (`src/flags/timing.py:week_has_closed`) avoids this by
construction (G4: it refuses to record until the signal week's Friday
15:30 IST has passed), but Control's own `record()`/`record_t1_shadow()`
have no equivalent guard today. Left for Dharmin to decide on a fix — not
changed as a side effect of this task.

**Known limitation of the `flags_2026-09-07` record specifically (audit AU06
correctly flags this — real finding, not a bug in the audit tool):** it was
written before `src/flags/matrix.py` was corrected to attach
`KNOWN_CAVEATS` directly rather than via `adapter.caveats()` (the
`OfflineAdapter` test fixture that this project's "live" runs actually go
through — see `tests/offline.py` — deliberately returns `[]` from
`caveats()`, since it's a hermeticity double, not a caveats source). That
2026-09-07 record's manifest therefore has `caveats: []`; every record from
this point on carries the real list. Per HARNESS §4/§8.5, the existing
record is not deleted or hand-edited to fix this — it is what it is,
documented here.

---

<!-- flags-audit:2026-09-07:9bc4ff5a0992ed09 -->

## 2026-09-07 flag-matrix audit (mode: late_backfill)

Full record: `results/feature_flags/flags_2026-09-07.csv`, audit:
`results/feature_flags/audit/audit_2026-09-07.json`

- Overall: **FAIL**
- Eligible rows: 264, T4 picks: none
- Control trades this week: JUBLPHARMA.NS, SPLPETRO.NS
- Noteworthy reasons: check_failed, recording_mode_late_backfill, first_record_for_registry_version

No graded week yet.

---

## 2026-09-15 — Threshold experiment registered; `build_trades()` `R <= 0` guard removed

**Control-file change (Dharmin's decision, kept).** `src/trade/builder.py` no longer rejects
`R <= 0`; it rejects only `R/EP > trade.max_r_pct`. Checked on the latest cached week (signal week
2026-09-07): selection unchanged (JUBLPHARMA, SPLPETRO traded; PINELABS rejected by the 15% cap).
It is a no-op in practice because EP is always the signal close and every survivor is in an
uptrend, so `R ≥ 0`; only `R == 0` exactly would now become a trade. The flag audit's AU03 will
report `src/trade/builder.py` drift until this is committed.

**Threshold experiment registered** (`docs/threshold-experiment-plan.md`, plan doc §3.10): shadow
arms `threshold-experiment_15/17.5/20/22.5/25/30/40/50`, each splitting Control's survivors into
SELECTED (`R/EP ≤ cap`) and REJECTED, equal-weight, forward-only, one decision per arm at 26
forward weeks. Before registering, only survivor **counts** by R% band were read from the 104-week
replay — no returns:

- On a flip bar, `R% of close = 200·ATR/close` exactly (576 survivors); max 27.7%.
- Counts: ≤15%: 241 · 15–17.5: 152 · 17.5–20: 105 · 20–22.5: 51 · 22.5–25: 22 · 25–30: 5 · >30: 0.
- The 15% cap rejects 58% of survivors; `_30/_40/_50` would have equalled "no cap" in all 104 weeks.

First record: `results/threshold_experiment/threshold_2026-09-07.json` (`late_backfill` — Control's
picks were written 14 Sep 01:06 IST, before that week's Monday open, but this threshold record
was written 15 Sep, after it, so the week does not count toward the gate). First forward week: signal week 2026-09-14, record due before
Mon 21 Sep 09:15 IST.

---

## 2026-09-16 — Open-decisions plan v1.0: defects D1/D2/D3/D5/D6 fixed, baseline restated, V2/V3/V4/V7/G registered, 2019+ holdout built, and a yfinance weekly-bar defect (D7)

Plan: `docs/open-decisions-implementation-plan.md` (decisions D1–D6 settled by Dharmin 16 Sep 2026:
data from 2019 onward; V6 out; V7 in; fix D1, D2, D3, D5, D6; add V2; guardrails validated on
their own risk metric **and** on returns).

**Harness fixes (`src/backtest/harness.py`), probe tests now pass:**
- D1 `simulate_week_forward` exits at the open when the week opens at/below the stop (`gap_stop_at_open`), same rule as `_grade_rows`.
- D2 `weekly_portfolio_returns(graded, calendar=fold_dates)` keeps zero-pick weeks as 0.0%.
- D3 `simulate_trend_hold` checks week *i* against week *i−1*'s stop (plus gap-at-open).
- D5 `trade_rejections()` lists every survivor `build_trades()` did not take; `run_backtest.py` saves `trade_builder_rejections.csv`.
- D6 graded trades carry `R`/`target` off the actual fill; signal-time values kept as `R_signal`/`target_signal`.
- D4 (flat-series RSI = 100) **left open** — `src/indicators/rsi.py` is a Control file.

**Baseline restated on the same 104 folds (2024-09-09 → 2026-08-31, offline cache):**

| | before fixes | after fixes |
|---|---|---|
| trades / hit rate | 241 / 36.5% | 241 / 36.5% |
| mean net per trade (CI95) | −1.285% (−1.87, −0.71) | −1.285% (−1.87, −0.71) |
| portfolio weeks | 74 (30 flat weeks dropped) | 104 |
| CAGR / Sharpe / max DD | −57.7% / −2.70 / −73.5% | −45.7% / −2.24 / −73.6% |
| exits | 238 week close, 3 stop | same — no gap-through-stop week in this window |
| trade-builder rejections | not visible | 335, all `risk_cap` |

Trade-level numbers are unchanged (D1/D6 didn't fire in this window); the portfolio series was
wrong by the 30 dropped weeks. Still firmly negative. Trend-hold (D3) was not re-run.

**New data defect D7 — yfinance weekly bars in Monday-holiday weeks.** Resampling the daily cache
to weekly and comparing with `weekly_ohlcv_260w.parquet` over 2021-07 → 2026-09 (122,067
ticker-weeks): 95.6% match raw. 4,519 of the 5,421 mismatches are weeks whose Monday was an NSE
holiday, where yfinance's weekly **open is the previous Friday's close** rather than the first real
session's open. Excluding those and the in-progress latest week, 99.66% match (the rest: the
Saturday 18 May 2024 special session missing from daily bars). Consequence: every consumer that uses
the weekly open as the entry price — `track_forward._grade_rows`, `simulate_week_forward`,
`grade_matrix`, and therefore the threshold experiment — books EP = signal-week close in those weeks.
**Mon 14 Sep 2026 was an NSE holiday (Ganesh Chaturthi), so the holding week for the 2026-09-07
picks is affected: its grade will use Fri 11 Sep's close as EP, not Tue 15 Sep's open.** Not fixed
here (Control's grader) — left for Dharmin to decide. New weekly history for dev/holdout is built from
daily bars (`src/data/resample.py`), which does not have this defect.

**Registered before any run** (`config/experiments.yaml`, checksum locked): V2 fixed N-week hold
(N ∈ {2,4,8}), V3 pullback limit entry (depends on V2), V4 same-week entry on daily confirmation,
V7a alpha decomposition and V7b short-signal mirror (diagnostics, never traded without a separate
F&O/borrow study), G guardrail calibration (dual criterion: own risk metric + returns
non-inferiority, CI lower bound ≥ −0.5 pp). Budget used: 3 of 7 (V2, V3, V4).

**`holdout_ext` built (counts only — no returns read):** signal weeks 2019-12-02 → 2021-06-28,
83 weeks, from `daily_ohlcv_1820d.parquet` (starts 2019-05-13; `scripts/backfill_history.py
--start 2019-01-01` extends it once run on a networked machine). Universe per week: 369–385
tickers with ≥ 30 bars, 133–189 in the ₹10–50k cr band (median ~155) vs 264 today — the holdout
universe is ~40% smaller and built from today's constituents, so survivorship bias is heavier than
in dev. Per-week counts: `results/evidence/holdout_ext_universe_counts.csv`. One pass, finalists
only, enforced by `src/data/segments.py`.
