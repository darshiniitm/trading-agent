# Weekly VStop + RSI Mid-Cap Screener & Backtest

Implementation of the design plan (`docs/design_plan.md` if you saved it — the
plan you approved). NSE equities, weekly timeframe, market-cap-banded universe,
VStop(10,2) flip + RSI(14) band screen, sector RS highlighting, EP/SL/confidence
trade objects, and a single-shared-code-path validation harness (single-week +
rolling walk-forward).

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Run

```bash
# Live screen as of the latest completed Friday
.venv/bin/python scripts/run_screen.py

# Live screen, quick smoke test on a small universe subset
.venv/bin/python scripts/run_screen.py --limit 100

# Full validation: single-week check + rolling walk-forward
.venv/bin/python scripts/run_backtest.py

# Shorter rolling window (data availability / speed)
.venv/bin/python scripts/run_backtest.py --weeks 52

# Add the secondary trend-hold exit horizon (§8.5 "B") to the same run
.venv/bin/python scripts/run_backtest.py --weeks 52 --trend-hold

# RSI band train/validate parameter-sensitivity study (§9.3)
.venv/bin/python scripts/rsi_param_study.py

# Survivorship-bias disclosure check (§3.3, §9) — quantifies what open-source
# data can and can't tell you about excluded delisted names
.venv/bin/python scripts/survivorship_check.py
```

Outputs land in `results/live/`, `results/backtest/`, and `results/rsi_study/`
as CSVs; console output prints the funnel, trade table, sector highlights, and
backtest metrics.

## Structure

```
config/rules.yaml            the strategy, as a rule spec (edit this to change what runs)
src/data/adapter.py           source adapter (opensource: yfinance + NSE archive CSVs)
src/indicators/                vstop.py, rsi.py, sector_rs.py
src/screen/engine.py          run_screen() — the ONE code path used live and in every backtest fold
src/trade/builder.py          EP / SL / R / target / confidence
src/backtest/harness.py       single-week check + rolling walk-forward + trend-hold + metrics + calibration
src/report/report.py          console + CSV output
scripts/run_screen.py         live screen CLI
scripts/run_backtest.py       validation CLI (--trend-hold for the secondary exit horizon)
scripts/rsi_param_study.py    RSI band train/validate sensitivity study
scripts/survivorship_check.py survivorship-bias disclosure (NSE delisted-companies archive)
tests/test_indicators.py      sanity tests for VStop flip logic and RSI bounds
```

## Locked parameters (design doc §11)

Market cap ₹10,000–50,000cr · VStop(10, 2) weekly, bullish flips only ·
RSI(14) Wilder weekly, band [50, 65] · liquidity ≥ ₹10cr median weekly
turnover (8w) · EP = next-week open · SL = VStop line · target = EP + 2R ·
costs = 0.5% round trip. Change these only in `config/rules.yaml`, and only
via a proper parameter-sensitivity study (design doc §9.3) — never by fitting
to the validation weeks.

## Known caveats (open-source data POC — design doc §3.3, §9)

- No point-in-time shares outstanding: market cap uses **today's** share
  count held constant across history.
- No delisted/merged tickers in the universe: backtest returns carry
  **survivorship bias upward**.
- Universe is the union of the current Nifty Midcap150 / Smallcap250 / Nifty500
  constituent lists (NSE archive CSVs), not a full point-in-time NSE listing —
  reasonable proxy for the ₹10–50k cr band, not exhaustive.
- yfinance weekly bars and corporate-action adjustment are not independently
  verified against a second source.

Do not trade on this without re-validating on a paid, corporate-action-clean
feed (design doc's `data_source: paid` swap point in `config/rules.yaml`).

## Findings so far (104-week rolling walk-forward, as of 2026-09-21)

**Restated 2026-09-29** after fixing `src/indicators/rsi.py:compute_rsi()`'s
seeding (was `ewm(...)` applied from bar 1 with no separate seed step; now a
textbook Wilder seed — simple average of the first 14 gains/losses, then RMA
recursion — validated to match TradingView's RSI to within 0.003 on a real
reference bar; see `docs/forward_test_findings.md`'s 2026-09-29 entry). This
also finally reconciles the window length with `CLAUDE.md` (104 weeks, not the
52-week figure previously quoted here, which was already stale before this
fix). This restatement supersedes both the original -1.07%/-2.6/-50% figures
below-this-note's history and the 2026-09-16 D1–D6 defect-fix restatement
(-1.285%/trade, Sharpe -2.24).

**Fixed 1-week exit (primary, RSI [50,65] default):** 239 trades / 73 weeks
(out of 104 folds), 36.8% hit rate, expectancy -1.24%/trade, portfolio CAGR
-43.15%, Sharpe -2.07, max drawdown -70.57%. Confidence calibration remains
directionally monotonic (bottom bucket 25.0% hit rate / -1.81% mean net return
→ top bucket 44.4% / -0.05%) — the confidence score is still doing real work,
but even the top bucket doesn't reach breakeven.

**Trend-hold exit (secondary, §8.5 "B" — trail the VStop until it flips
down), re-run 2026-09-29 with the fixed RSI and the 104-week window (was
52-week, 162 trades):** same 239 trades as the primary exit, held 11.09 weeks
on average (median 9.0). Hit rate **28.9%** (was 45.7%), mean per-trade return
**-1.45%** (was +2.9%). Unlike the pre-fix run, the mean per-trade
**annualized** return is now also negative: **-16.4%** (was +17.0%), median
**-31.3%** (was -4.9%), std 86.5% (was 104%) — still hugely dispersed, but the
"a few large winners carry a positive mean" story from the pre-fix run does
**not** hold here; both mean and median are now negative. 82.0% of trades
exit via stop (was 72.8%), 0.8% via a friendly trend-down flip. This is a
materially different result from the pre-fix number, not just a refresh —
worth being direct about that rather than treating it as noise. Two things
changed at once (the RSI fix and the window: 52→104 weeks), so this restated
figure isn't a clean isolation of the RSI fix's effect alone; still, read
"trend-hold looks better than the fixed-week exit" with real caution now more
than before — it plainly doesn't, on this window. Not directly comparable to
the fixed-week numbers either way (different risk profile, no apples-to-apples
portfolio Sharpe — see `trend_hold_return_stats` docstring for why a portfolio
CAGR/Sharpe isn't reported here).

**RSI band sensitivity study (§9.3), re-run 2026-09-29 with the fixed RSI**
(TRAIN 2024-09-30→2025-09-22, VALIDATE 2025-09-29→2026-09-21, both 52 weeks):
swept the same 9 candidate bands on TRAIN (all a-priori, none looked at
validate first). **Every single band still had negative expectancy on
train.** The band selection itself changed under the fixed RSI — robustness
now picks **[60,75]** (was [35,50] pre-fix) — but the conclusion doesn't: on
VALIDATE, the selected band's expectancy (-0.958%, n=38, hit rate 34.2%) is
now roughly *in line with*, not worse than, the a-priori [50,65] default
(-0.950%, n=151, hit rate 35.1%) — both negative, nearly identical. Pre-fix,
the selected band had clearly *underperformed* the default (-1.91% vs
-1.07%); post-fix that gap has closed to noise. Either way: no band in a
reasonable range rescues the strategy — this isn't an RSI-band-tuning
problem, before or after the fix.

**Survivorship bias (§3.3, §9):** the only open-source NSE delisted-companies
list is **stale since 2020-11-09** — it cannot even give a lower-bound count
of names excluded from the recent backtest window. Empirically confirmed
yfinance has zero price history for 5/5 sampled delisted names, so this gap
is structurally unfixable within the open-source POC. Treat every return
figure above as biased upward by an unknown, unquantified amount.

**Bottom line:** under the locked a-priori parameters, with the fixed
1-week exit the strategy the brief describes has a negative edge over the
104-week window, and the RSI-band sweep (re-run post-fix, same conclusion
either way) confirms this isn't fixable by moving the RSI band. The
trend-hold variant, re-run 2026-09-29, is **not** the "mean-positive but
median-negative" story it used to be — both mean and median per-trade
annualized return are now negative, on top of still being highly dispersed —
so it no longer offers even the qualified silver lining the pre-fix numbers
suggested. None of this should be traded on the open-source data feed
regardless of the numbers.
