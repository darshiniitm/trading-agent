# Watchlist views — TradingView parity

**Status: not yet run.** The golden values from the 15 Oct 2026 TradingView screenshots are not in the repo, and the
screenshots' exact capture date/time was never confirmed (plan Task 0), so
`tests/fixtures/tv_watchlist_2026-10-14.json` is a template with no values. No parity number below is real until it is
filled — nothing here was estimated or back-filled.

## To run

1. Confirm the screenshots' capture date/time and enter it as `captured_at`.
2. Fill each symbol's `values` (NIFTY, BANKNIFTY, SENSEX, CNXIT, RELIANCE, AXISBANK, HDFCBANK, ICICIBANK, BAJFINANCE) from the five screenshots; leave a metric `null`/absent if its cell wasn't visible.
3. `python -m scripts.watchlist_parity` (needs network) — it overwrites this file with the metric · ours · TradingView · pass/fail · note table.

Yahoo only returns the latest bars, so run it the same trading day as the capture, or the values will legitimately drift.

## Tolerances (plan §6) and what to adjust on failure

| Metric | Tolerance | If it fails |
|---|---|---|
| Perf 1W–5Y | ±0.3 pp | check adjusted vs unadjusted closes, then the "on or before" date rule |
| Avg Vol (10), Market cap | ±3 % | check session vs consolidated volume (NSE vs NSE+BSE) |
| Beta 1Y/3Y/5Y | ±0.10 | switch 3Y/5Y to weekly returns; re-test |
| Volatility 1D/1W/1M | ±0.15 pp | switch definition (mean H−L range → stdev of returns) |
| RSI, CCI, Mom, AO | ±1 % of value | check bar alignment (incomplete bar excluded) |
| MA / Os / Tech rating label | exact label on ≥ 8 of 9 symbols | inspect `votes_json` per indicator |
| P/E, EPS, Yield | ±5 % | fundamentals lag is expected; document, don't force |

Definitions may only be changed where this table allows. Known, expected mismatches already documented in the UI
tooltips: "All time" depends on Yahoo's history depth; ratings are our implementation of the TradingView method.

## Open points the first run should settle

- Os Rating's oscillator rules follow TradingView's published recommendation rules as implemented in `engine/metrics.py`; the plan's "Stoch RSI(3,3,14,14)" and "Ultimate Oscillator" rule thresholds were taken from the commonly published TradingView technicals logic and are unverified against the screenshots.
- Volatility 1D/1W/1M uses mean `(High − Low) / Low` over 1 / 5 / 21 sessions (plan §3). Verify against the screenshot (NIFTY 0.88 % / 1.61 % / 1.12 %).
