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

## Findings so far (52-week rolling walk-forward, as of 2026-08-29)

**Fixed 1-week exit (primary, RSI [50,65] default):** 162 trades / 45 weeks,
35.8% hit rate, expectancy -1.07%/trade, portfolio Sharpe -2.6, max drawdown
-50%. Confidence calibration is genuinely monotonic (bottom bucket 17.1% hit
rate → top bucket 51.5%, mean net return -1.9% → +0.1%) — the confidence
score is doing real work, but even the top bucket barely breaks even.

**Trend-hold exit (secondary, §8.5 "B" — trail the VStop until it flips
down):** same 162 trades, held ~9.6 weeks on average. Hit rate improves to
45.7%, mean per-trade return +2.9%, but the **median** per-trade annualized
return is **negative** (-4.9%) against a **positive mean** (+17.0%) with huge
dispersion (std 104%) — a few large winners are carrying the average while
most trades still lose. 72.8% of trades exit via stop, not via a friendly
trend-down flip. Read "trend-hold looks better" with real caution: it is not
directly comparable to the fixed-week numbers (different risk profile, no
apples-to-apples portfolio Sharpe — see `trend_hold_return_stats` docstring
for why a portfolio CAGR/Sharpe isn't reported here).

**RSI band sensitivity study (§9.3):** swept 9 candidate bands on a 52-week
TRAIN window (all a-priori, none looked at validate first). **Every single
band had negative expectancy on train.** The least-bad band, [35,50], is a
thin sample (9 trades/6 weeks) and *underperformed* the a-priori [50,65]
default when run once on the untouched VALIDATE window (-1.91% vs -1.07%
expectancy). Conclusion: this isn't an RSI-band-tuning problem — no band in
a reasonable range rescues the strategy.

**Survivorship bias (§3.3, §9):** the only open-source NSE delisted-companies
list is **stale since 2020-11-09** — it cannot even give a lower-bound count
of names excluded from the recent backtest window. Empirically confirmed
yfinance has zero price history for 5/5 sampled delisted names, so this gap
is structurally unfixable within the open-source POC. Treat every return
figure above as biased upward by an unknown, unquantified amount.

**Bottom line:** under the locked a-priori parameters, with the fixed
1-week exit the strategy the brief describes has a negative edge over the
last year, and a parameter sweep shows this isn't fixable by moving the RSI
band. The trend-hold variant shows a mean-positive but median-negative,
highly dispersed outcome — more research (position sizing / risk of ruin
under that dispersion) is needed before calling it an edge. None of this
should be traded on the open-source data feed regardless of the numbers.
