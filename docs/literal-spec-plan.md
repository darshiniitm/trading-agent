# Literal spec — decisions and reuse-vs-modify audit

Companion to `config/rules_literal.yaml`. This file records the decisions behind that
spec and is the reference for "why does Literal do X" — the spec file itself stays
terse. Not a Control variant; never feeds `config/rules.yaml` or Control's forward-test
record. See `docs/forward_test_findings.md` (2026-09-26 entry) for the dated log entry,
and `.claude/HARNESS.md` for the rules this spec must not break.

## Origin

A Claude Docs review ("Strategy Re-alignment — Brief vs Build, Gaps & Fix Plan",
26 Sep 2026) compared the original 5-step trading brief against what the repo actually
implements as "Control" (`config/rules.yaml`) and found 10 gaps (G1–G10), most of them
undocumented interpretations frozen in without being re-checked against the brief. This
spec is the fix: a from-scratch, literal reading of the same 5 steps, run as its own
series alongside (not instead of) Control.

## Decisions (26 Sep 2026, Dharmin)

1. **Universe**: full NSE EQ-series equity list (not the ~500-name index-constituent
   proxy Control uses), daily history from **2024-01-01** onward (not back to 2019).
2. **Proceed even though it winds down Control.** Control keeps recording for 4–6 more
   weeks alongside Literal (`tests/track_forward.py:CONTROL_WIND_DOWN`, provisional last
   week 2026-10-23), then stops. Consequence, accepted explicitly: the threshold
   experiment (`config/threshold_experiment.yaml`) and the T4 flag-matrix arm
   (`config/feature_flags.yaml`) are both derived solely from Control's own weekly picks
   file and need 26 forward weeks to reach their statistical gate; neither can get there
   before Control's recording ends. Both are marked `status: orphaned_insufficient_forward_weeks`
   rather than left to silently starve.
3. **Reuse-vs-modify methodology**: for every place Literal needs logic Control already
   has, compare the existing implementation against a literal reading of the brief.
   Reuse as-is if it matches; modify (in the shared file, config-driven, never a forked
   copy) if it diverges. See the audit table below.
4. **Fix D4** (flat-series RSI returning 100 instead of neutral 50) — in
   `src/indicators/rsi.py`, a file Control also uses. Going forward only; Control's past
   records are not re-graded (HARNESS rule 4).
5. **RSI band**: 50 to 65 — same as Control, no new value needed.
6. **VStop parity reference**: JUBLPHARMA.NS, signal week ending Friday 2026-09-11 2026
   (a real `flip_up == True` signal from `results/forward_test/picks_2026-09-07.json`,
   not a guess) — stop-line ≈ ₹889.72, signal close ₹1025.10.

   **Closed out 2026-09-28**, with a different real-world reference (KAYNES.NS, not the
   JUBLPHARMA.NS one above — Dharmin compared a live TradingView chart instead):
   `scripts/vstop_parity_check.py` (new, diagnostic-only, no production code changed).
   TradingView's "VStop 10 close 2" read 3311.7 against our own two numbers, 3383.48 and
   3394.82 — a ~2.5% gap that turned out to be a comparison error, not a defect: those two
   numbers came from the *daily-bar* VStop (`daily_scale.py`'s T1/midweek-scan path,
   length=10 **trading days**, a different, faster indicator), not the *weekly* VStop
   `config/rules_literal.yaml` and TradingView both use. Weekly-vs-weekly, our last-closed-week
   reading was 3265.08 (Fri 2026-09-25 close) — still off from 3311.7, because the TradingView
   read was taken while the *current* week (2026-09-28) was still open, and TradingView plots
   VStop live against the in-progress week's own OHLC-so-far, not the last closed week. Extending
   our own weekly panel with that same in-progress week's elapsed daily bar (fetched fresh,
   O=3623.80 H=3695.00 L=3589.00 C=3658.00 — verified to match the TradingView candle exactly, so
   no yfinance-vs-TradingView data mismatch either) and recomputing gives **3311.68** — matches to
   the cent. Also tested and ruled out as contributing factors: `wilder_atr()`'s EMA-from-bar-1
   seeding vs a textbook SMA-seeded Wilder ATR (delta 0.0000 after 201 weeks of history — any
   seed difference has long since decayed away), and history-window length (260w vs 130w vs 104w,
   deltas under 0.004). **No code change needed or made** — `compute_vstop()` is validated as
   correct against a real chart when compared on a like-for-like (same week, same OHLC) basis.
   Full findings: `docs/forward_test_findings.md`, 2026-09-28 entry.
7. **Entry Price (EP)**: Friday's own signal close — the brief's literal default — not
   Control's next-Monday-open. Monday's open is still captured, as
   `next_week_open_check`, purely informational.
8. **Deferred, revisit later**: the "266 vs 264 stocks in band" factual discrepancy in
   the original review doc, and the fact that several files this plan touches were
   uncommitted at the time of writing. Not blocking.

## Decision (26 Sep 2026, later same day, Dharmin) — benchmark changed to Nifty 50

**9. Benchmark: Nifty 50 (`^NSEI`), not Nifty Midcap 150.** `sector.benchmark`/
`benchmark_ticker` in `config/rules_literal.yaml` changed from `NIFTY_MIDCAP_150`/
`NIFTYMIDCAP150.NS` to `NIFTY_50`/`^NSEI` (confirmed reachable via yfinance — a real
index level, not a delisted/empty ticker; `NIFTY50.NS` and `^CNX50` both return no
data). Rationale: track Literal/T1's own return performance against the broad market,
not a mid-cap-specific index. This is Literal-only — Control's `config/rules.yaml`
keeps `NIFTYMIDCAP150.NS` unchanged (HARNESS rule 1: a Control-file change is a
separate, deliberate decision, not a side effect of this one).

One ticker feeds two things, both intentionally: (a) sector relative-strength ranking
(`sector_rs`, feeds `candidate_score`'s edge component) is now computed against Nifty
50 instead of the mid-cap index, and (b) a new per-week "our basket vs the benchmark"
comparison (`_benchmark_week_return()`, shared by `grade()`/`replay()`/`t1replay()` in
`tests/track_literal.py`) — the benchmark's own open-to-close return over the same
holding week our trades are scored against. Actual trade returns (EP, SL, exit price,
`ret_pct`/`ret_pct_net`) are unaffected either way — the benchmark never enters the
VStop+RSI survivor selection or the R/EP calculation, only sector scoring and this new
comparison line.

`^NSEI`'s weekly and daily bars were fetched directly into `data_cache_literal/`'s
existing parquet files (merged in, not a fresh full backfill — a single-ticker fetch,
seconds not minutes). Both retrospective replays (`replay()`, `t1replay()`) were
re-run against the new benchmark; see the dated findings entry for the numbers.

| Component | Brief-compliant today? | Action taken |
|---|---|---|
| `src/data/holding_week.py:corrected_week_bar` (D7 fix) | Yes — an honest fill price, not a strategy predicate | Reused as-is, called from Literal's grader (`tests/track_literal.py`) too |
| `src/indicators/vstop.py` | Verified 2026-09-28 (decision 6) — matches TradingView to the cent on a like-for-like basis | Reused as-is; no code fork, no change needed |
| `src/indicators/rsi.py` | No — D4 flat-series bug | Modified in place (shared by Control and Literal; see decision 4) |
| `src/screen/engine.py:run_screen()` | Yes — funnel structure matches brief steps 1–2 | Reused unmodified, driven by `rules_literal.yaml` + the new universe loader |
| `src/trade/builder.py:build_trades()` | No — `max_r_pct` acted as a second filter beyond "a trade for every qualified stock" | Modified: `max_r_pct: null` (Literal) now means no cap; Control keeps `0.15`. One function, config-driven, not a fork |
| `tests/track_forward.py:_grade_rows()` | No — always overrode EP with the following week's open | Modified: new `entry_price_source` param (`"next_week_open"` default = Control's existing behavior, unchanged; `"signal_close"` = Literal's). Also fixed a real bug this surfaced: the gap-stop-at-open check must compare the following week's real open against SL, never against EP — checking EP would have silently disabled gap-stop detection under `signal_close` mode, since EP there is fixed above SL by construction |
| `src/data/adapter.py` universe loading | No — only reads the 3 index-constituent CSVs | Added `_fetch_full_equity_list()` / `_load_universe_full()`, gated by `universe.source: full_nse_equity_list`; Control's `index_lists` path is untouched (default) |

## Known limitations carried forward, not silently

- No free source gives point-in-time historical shares outstanding — market cap still
  uses today's share count held constant across history, now across ~4x more tickers.
  See `src/data/adapter.py:FULL_LIST_KNOWN_CAVEATS`.
- NSE's full equity list has no sector column. `sector_map_pit()` backfills sector from
  the existing index-constituent CSV union where a symbol is covered, and reports
  `"Unknown"` for the rest — an explicit gap, not a silently wrong sector.
- ~~The full-equity-list endpoint (`archives.nseindia.com/content/equities/EQUITY_L.csv`)
  was not reachable from the sandbox this was built in~~ — **resolved 26 Sep 2026**: the
  endpoint is reachable from outside that sandbox (confirmed via a real fetch, see below).

## Full-NSE backfill (done 26 Sep 2026)

`data_cache_literal/` is now populated from a real fetch, run outside the sandbox
this spec was designed in: `scripts/bootstrap_literal.py` (a chunked/retried wrapper
around `scripts/common.py:bootstrap('config/rules_literal.yaml')` — a single
~2300-ticker `yf.download()` call reliably trips Yahoo's rate limiter, so this
fetches in batches of ~30-40 with backoff instead) for the universe list, weekly
OHLCV, and shares outstanding, and `scripts/backfill_history.py --config
config/rules_literal.yaml --start 2024-01-01` for the daily bars T1's rolling-window
scan needs. Coverage: 2317/2317 tickers with weekly OHLCV, 2214/2317 (95.5%) with
shares outstanding (the rest genuinely have none available via yfinance — not a
fetch failure), 2318/2318 tickers (universe + benchmark) with zero missing daily
bars from 2024-01-01 onward. `tests/offline.py:OfflineAdapter._load_daily_panel()`
was widened to also discover a `daily_ohlcv_since_<start>.parquet` file generically
(previously only `ExtendedOfflineAdapter` special-cased this for Control's cache
dir) so `env_literal_with_daily()` can find it.

This surfaced one real, previously-latent bug: `src/screen/candidate_score.py:
guardrails()` assumed a numeric risk cap always exists and crashed on `None * 100`
the first time it scored a candidate under Literal's `max_r_pct: null`. Fixed by
treating "no risk cap" as full credit on that guardrail dimension (nothing to have
headroom against), not a discount — see `tests/test_candidate_score.py`'s
`test_no_risk_cap_gives_full_headroom_credit_instead_of_crashing`.

## Real replay (backtest evidence, over the real full-NSE universe)

`tests/track_literal.py:replay(n_weeks)` was rewritten to run over the real
`data_cache_literal/` universe now that it's backfilled (previously ran over
Control's old proxy universe as a stopgap — that run's output is left on disk at
`results/literal_test/replay/literal_replay_2026-06-29_2026-09-14.csv` as a dated,
superseded artifact, not deleted). It still writes only to `results/literal_test/
replay/`, never to the immutable `picks_*.json` forward-record path, and is
backtest evidence, not a forward record (HARNESS rule 4). Also added: a T1-on-
Literal replay (`tests/track_literal.py:t1record()/t1grade()/t1replay()`), the same
`src/screen/t1_scan.py:scan_t1_week()` scan T1 already runs for Control, fed
Literal's environment instead — same code, no fork, per HARNESS §2.

## What's still open

- The VStop parity chart-check (decision 6) is closed — see the updated entry above,
  2026-09-28.
- A real Literal forward record now exists: `results/literal_test/picks_2026-09-21.json`
  (first live `record()`, triggered 2026-09-28 — same-day, past that week's own Monday
  open, so logged as informational/late rather than a blind pre-open forward test; see
  `docs/forward_test_findings.md`'s 2026-09-21 entry for the full caveat).
