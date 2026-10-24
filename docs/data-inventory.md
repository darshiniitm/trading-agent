# Data inventory (Supabase plan §4.1)

Producer → file pattern → grain → target table. "Loader" = `db/load/backfill.py` sub-command.

| File / pattern | Producer | Grain | Target | Loader | Gaps |
|---|---|---|---|---|---|
| `data_cache/equity_master/<date>.csv` | `src/data/adapter.py` | symbol | `stock_master.stocks` | `reference` | `.NS` suffix added to match code symbols |
| `data_cache/universe_{nifty500,midcap150,smallcap250}.csv`, `data_cache_literal/universe_*.csv` | adapter | symbol | universe membership (scope for prices) | `prices` | no table: membership is a code-side proxy (KNOWN_CAVEATS) |
| `data_cache/sector/sector_map.parquet` | adapter | ticker | `stock_master.sectors`, `stock_master.stock_sector_history` | `reference` | industry not loaded (sector only); no history, valid_from = 1900 |
| `data_cache/ohlcv/daily/*.parquet`, `daily_ohlcv_*.parquet` (both caches) | adapter, `scripts/backfill_history.py` | ticker × day | `market_data.daily_prices`; derived `market_data.weekly_prices` | `prices` | priority: per-ticker cache, then older parquets; `adj_close` null (source unverified); `--scope universe` (default) limits to index-universe tickers for DB size |
| `data_cache/weekly_ohlcv_*.parquet`, `data_cache/ohlcv/bhavcopy/*` | adapter | ticker × week / day | not migrated | – | weekly bars are re-derived from daily (`src/data/resample.py`); bhavcopy is a raw cache |
| *(derived)* | – | day | `stock_master.trading_calendar` | `calendar` | derived from days with ≥50 tickers traded |
| `data_cache/shares_outstanding.json`, `data_cache/_meta/provenance.sqlite` | adapter | – | not migrated | – | `stock_master.stock_market_cap_history` is created but unfilled: mcap per week lives in each run's candidate `snapshot` |
| `results/forward_test/picks_<wk>.json` (+ `_graded`, `_near_miss` csv) | `tests/track_forward.py` | run; pick; near-miss; graded detail | `forward_testing.weekly_runs/candidates/trades/trade_outcomes` (arm `control`) | `forward` | 1-week horizon only; `_t1.json` → arm `T1`; csv twins are derivable and not loaded |
| `results/literal_test/picks_<wk>.json`, `t1_picks_*.json` | `tests/track_literal.py` | same | same (arms `literal`, `literal-T1`) | `literal` | `horizons/*.jsonl` (1/2/3-wk outcomes) and `replay/` are **not yet loaded** |
| `results/feature_flags/flags_<wk>.csv` + `.manifest.json` | `tests/track_flags.py` | run × ticker | `forward_testing.screen_candidates` (+`snapshot`), `forward_testing.candidate_condition_flags` (arm `flag-matrix`) | `flags` | `_graded.csv`, ledgers, `replay/` and audit files not loaded |
| `results/threshold_experiment/threshold_<wk>.{csv,json}`, `threshold_ledger.csv` | `tests/track_threshold.py` | run × cap × ticker | `forward_testing.strategy_arms` ×8, `forward_testing.screen_candidates`, `forward_testing.experiment_metrics` | `threshold` | `_graded.csv` and summaries not loaded |
| `results/wow/*`, `results/backtest/*`, `results/experiments/*`, `results/rsi_study/*`, `results/evidence/*`, `results/live/*` | analysis scripts | study outputs | **not migrated** (derived research artefacts; stay as files) | – | `results/evidence/segment_reads.csv` is the read ledger — keep as a file |
| `config/*.yaml` | hand-edited | – | `fwd.arms.rule_config` (control, literal only) | `forward`/`literal` | YAML stays the source of truth (checksum-locked) |
| *(none exist yet)* | – | – | `app.*`, `kb.*`, `prompt_details.*` | – | frontend (`frontend/apps/web`) is empty; tables are created, nothing to migrate |

Immutability rules (HARNESS §4, §12) still apply: the loader only reads result files and never rewrites them.
