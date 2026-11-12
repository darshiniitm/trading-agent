# Watchlist views (P6) — implementation notes

Implements the P6 plan (Price · Financials · Performance · Risk · Technicals over the prompt watchlist; Screen stays the default). Display only: no view value reaches screening, selection or grading (enforced by `tests/engine/test_metrics_api.py` and `frontend/apps/web/tests/watchlist-views.test.ts`).

| Layer | Files |
|---|---|
| Engine | `engine/metrics.py`, `engine/fundamentals.py`, `engine/metrics_service.py`; `GET /metrics`, `/fundamentals`, `/history/{symbol}`; `/quotes` now also returns `volume` |
| Web data | migration `0012_watchlist_views.sql`, `src/server/viewData.ts` (benchmarks, prefs, compute/store), `views.ts` (read model), `viewsApi.ts`; routes `watchlists/[id]/views`, `view-prefs`, `me/benchmarks`, `series/history` |
| Job | `scripts/run-weekly-jobs.ts` calls `computeAllWatchlistMetrics` after the weekly screen (non-fatal) |
| UI | `src/components/watchlist/{ViewSwitcher,ViewToolbar,ViewGrid,ColumnPicker,TechTimeframeToggle,BenchmarkPanel}.tsx`, `columns/*`, `src/lib/{viewFormat,ratings,viewCsv}.ts` |
| Parity | `scripts/watchlist_parity.py`, `tests/fixtures/tv_watchlist_2026-10-14.json` (EMPTY), `docs/watchlist-views-parity.md` |

## Rulings (deviations from the plan)
- Web DB is SQLite, so the schema is a web migration, not Postgres `app.*`; no `price_daily` table — the engine fetches daily history on demand (6h parquet cache in `data_cache/views_daily`).
- USDINR=X is INR per USD, so INR→USD **divides** by it (`usdPerInr = 1/rate`); the plan said multiply.
- USD toggle and tech timeframe switch client-side (plan §9 "instant"); server returns INR + fx. Only a first-time 1W technicals load fetches.
- Screen view keeps the existing `WatchlistGrid` (it now converts LTP/Entry/Stop for USD); the five new views use `ViewGrid`. `/views` has no `screen` group.
- Benchmark detail panel uses weekly closes from the engine's `/history` (index symbols only).

## Not done / needs the owner
- **Parity run:** fill the fixture from the 15 Oct screenshots (and confirm their capture time), then `python -m scripts.watchlist_parity`.
- **Screenshots at 1440/390 px:** `STORAGE_STATE=<signed-in session> BASE=... npx tsx scripts/ui-screens.ts` (the app has no auth bypass).
- Os-rating thresholds for Stoch RSI / Ultimate Oscillator are unverified against TradingView.
