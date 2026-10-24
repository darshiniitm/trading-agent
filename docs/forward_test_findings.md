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

---

## 2026-09-16 — D7 fixed; 2019-01→05 daily backfill run; open-decisions Phase 0 (commit) done

**D7 fixed** (`src/data/holding_week.py:corrected_week_bar()`): in a week whose Monday is an
NSE holiday, prefer that holding week's own daily sessions (via `adapter.daily_ohlcv()`, the
cache T1 already maintains) for EP/low/close over the weekly bar, which reported the previous
Friday's close as the open. Wired into `tests/track_forward.py:_grade_rows` (so `grade()`,
`grade_t1()`, and the threshold experiment — which derives from Control's own graded detail —
all pick it up), `src/flags/grade.py:grade_matrix`, and `src/backtest/harness.py:simulate_week_forward`
(new opt-in `daily_panels=` param; omitting it — as the existing 104-week walk-forward and
`scripts/run_backtest.py` still do — leaves that baseline's numbers exactly as restated
15/16 Sep, since it never reads daily bars). Nothing was re-graded retroactively — rule 4.
Probe: `tests/test_d7_holding_week.py`. Full suite: 231 passed, 1 known failure (D4, left open
by decision). The 2026-09-07 forward record (still ungraded) will now grade with the corrected
EP/low/close for its Mon-14-Sep-holiday holding week instead of booking EP = signal close.

**`scripts/backfill_history.py --start 2019-01-01` run** (network worked from this session,
despite the prior note that it couldn't be probed offline): 501/502 tickers fetched into
`data_cache/daily_ohlcv_since_2019-01-01.parquet` (817,130 rows, one ticker — a synthetic
placeholder `DUMMYHEG.NS`, not a real listing — missing/delisted, harmless), first dates all at
2019-01-01 for 368 of 501 tickers, 134 tickers start later (post-2019 listings). This is the
data source `tests/offline.py:env_extended()` already prefers when present, so `holdout_ext`
now has its full 2019-01 → 2021-06-28 span rather than starting from the 2019-05-13 cache.
Counts not re-quantified in this entry (§4/holdout_ext sizing used the 2019-05-13 cache) — the
next study reading `holdout_ext` should re-run `results/evidence/holdout_ext_universe_counts.csv`
generation against the new file.

**Open-decisions plan P0 step 1 done:** the threshold experiment, `build_trades()` R<=0 removal,
harness defect fixes/baseline restatement, experiment registry, and segments module — all
previously uncommitted — are now committed (`861888d`). AU03 drift flagging on those files stops.
P0 step 2 (locate `picks_2026-08-24/31.json`) is still open; not attempted here since it requires
knowing what other machine they might be on.

---

## 2026-09-16 — V2/V3/V4 built and run on dev (2021-07 → 2024-07): all clear their kill criteria

Built per docs/open-decisions-implementation-plan.md §2/§5, registered ids V2/V3/V4
(`config/experiments.yaml`). Window: signal weeks 2021-07-05 → 2024-07-01 (416 Control signals,
157 weeks) -- the part of `dev` unread for returns before today.

**V2 (`src/backtest/v2_horizon.py`, `scripts/run_v2_backtest.py`) -- fixed N-week hold, static
signal-week stop (never trailed):**

| N | n trades | hit rate | expectancy/trade | CI95 |
|---|---|---|---|---|
| 2 | 416 | 46.2% | +0.13% | [-0.41%, +0.67%] |
| 4 | 416 | 55.3% | +1.61% | [+0.81%, +2.41%] |
| 8 | 416 | 57.9% | +3.86% | [+2.58%, +5.15%] |

Kill ("no N with net expectancy per trade > 0 on dev") not triggered -- N=8 clearly positive.
N*=8 carried forward as the "best N" for V3/V4's second horizon.

**V3 (`src/backtest/entry.py:pullback_limit_fill`, `src/backtest/daily_exit.py`) -- pullback
limit entry, `scripts/run_v3_v4_backtest.py`:** fill rate **100%** (415/416; every Control
signal's price traded back down to its own signal-week close within 5 sessions in this window)
-- flagged here as an unusually clean number worth Dharmin's scrutiny before trusting it (possible
adjusted-close/backfill artifact, or a genuine feature of a volatile mid-cap universe -- the
revision plan's own "-0.87% one-week give-back" finding says pullbacks are common, which points the
same direction but a literal 100% still deserves a second look). Week-1 expectancy +3.46%
(CI95 [+3.17%, +3.77%]), N*=8 expectancy +7.22% (CI95 [+5.96%, +8.48%]); both **beat Control's own
paired 1-week baseline on the identical signals** (+4.07% and +7.83% respectively, CI95 lower
bounds well above zero). Kill not triggered.

**V4 (`src/backtest/entry.py:same_week_entry`) -- same-week confirmation:** only 49/416 (11.8%)
signals confirmed early within the signal week itself (most of this mid-cap universe's flips are
genuinely Friday-only events); week-1 expectancy is near flat (-0.14%, CI95 includes zero) but
still **beats Control's own paired baseline** by +0.48% (CI95 [+0.29%, +0.69%], entirely above
zero) -- i.e. Control's own 1-week baseline in this window is more negative than V4's near-flat
result. N*=8 expectancy +4.12%, vs-Control +4.75%. Kill ("expectancy not above baseline") not
triggered under a vs-Control-paired reading; note the registered kill text doesn't specify the
exact CI arithmetic, so this run used "CI95 upper bound of the vs-Control delta <= 0" as the kill
trigger (a conservative choice -- only kills when even the optimistic end of the interval shows no
edge). Confirm this interpretation is the one you want before treating V4 as cleared.

**Reading across V2/V3/V4 together:** all three point the same direction -- Control's own 1-week
baseline carries a real, systematic give-back in the days right after the flip week (also visible
as the gap between each variant's absolute expectancy and its vs-Control delta, which is
consistently ~0.5-0.6pp in every row above). Nothing here is a holdout_ext or forward result --
still dev, still exploratory, and this window (2021-07 to 2024-07) has a different regime mix than
the 2024-08 to 2026-08 window the original 104-week walk-forward read.

**Also done:** `scripts/backfill_history.py --start 2019-01-01` run successfully (network worked
this session) -- see prior entry. D7 (weekly holiday-open defect) fixed -- see prior entry.
Open-decisions plan P0 step 1 (commit prior uncommitted work) done -- see prior entry.

**Not done in this pass (deferred, per scope agreed at the start of this task):** V7a/V7b
(short-side diagnostics) and G (guardrail threshold calibration). P0 step 2 (locate
`picks_2026-08-24/31.json`) still open.

---

## 2026-09-07 signal week graded (grade run 2026-09-19)

Full record: `results/forward_test/picks_2026-09-07.json`. Holding week 2026-09-14 to
2026-09-18 — Monday 2026-09-14 was again an NSE holiday (D7 case), same as the
2026-09-07-holding-week entry above.

Control: 3 survivors, 2 traded (risk cap rejected PINELABS.NS). Traded basket net
**+4.353%** (JUBLPHARMA.NS +3.421% net, SPLPETRO.NS +5.286% net) vs. the pre-registered
prior expectation of -1.81%. Shadow (risk-cap-rejected) PINELABS.NS: -5.511% — the risk
cap helped this week. T2 (1%/R weight) +4.426%, T3 (confidence weight) +4.277%. One week,
not evidence.

T1 daily-scale shadow: 14 signals, basket net -0.043%; the score>=40 sub-basket (n=7) was
worse at -0.612%.

Threshold experiment: arms 15/17.5 matched Control's basket exactly (same 2-ticket
selection); arms >=20 additionally selected PINELABS.NS, which was the week's loser, so
those wider arms underperformed Control by -3.288pp. X4/X5/X6 invariants all passed.

Flag matrix: graded cleanly, `n_missing_forward_bar=0`. `t4_basket_net_pct` is still
`null` — expected, T4's `k` stays `null` per the 2026-09-15 kill-criterion finding.

**D7 caveat — the fix did not actually fire for this record.** `corrected_week_bar`
(`src/data/holding_week.py`, landed 2026-09-16) is supposed to replace the weekly bar's
corrupted "open" (= prior Friday's close, on a holiday Monday) with the real first
session's open, sourced from the daily cache. For this grade run, `data_cache/
daily_ohlcv_1820d.parquet` was 137h stale (last refreshed 2026-09-14, before this
grade even had bars to read) at the moment `grade()` was first invoked, so every ticker's
`corrected_week_bar` fell back to `ep_source: "weekly_bar"` — i.e. **EP_actual (1025.20 /
198.85 / 818.35) is the classic D7-corrupted value, not a real fill**, for all three
graded rows this week. The daily cache was refreshed *after* grading; because `grade()`
is idempotent and short-circuits once `rec["graded"]` is set (by design — an immutable
record), this could not be re-graded with corrected data without hand-editing a graded
record, which HARNESS.md forbids. Read this week's `exit_price`/`week_close` values
(sourced from the weekly bar's own close, unaffected by the open-side bug) as reliable;
read `EP_actual`/entry-side numbers as the same known-corrupted value the pre-fix code
would have produced.

**New residual defect spotted while investigating the above:** even with a fresh daily
cache, `corrected_week_bar` would likely still have picked the wrong open here. yfinance's
daily bars return a zero-volume placeholder row *on* the holiday Monday itself
(`2026-09-14: open=high=low=close=1025.199951, volume=0`, identical to the prior Friday's
close) before the first real session (`2026-09-15`, open 1040.00). `corrected_week_bar`
takes `days.iloc[0]["open"]` after sorting by date, with no volume filter, so it would
have picked the Monday placeholder's open — numerically identical to the pre-fix
weekly-bar bug it's meant to fix. `tests/test_d7_holding_week.py`'s synthetic panels all
use `volume=[1e6]*len(dates))`, so this case isn't covered by the existing test suite.
Not fixed here (out of scope for this task) — flagged for Dharmin.

## 2026-09-26 — Literal spec started (docs/literal-spec-plan.md); D4 fixed; Control
## wind-down begins; threshold experiment and T4 orphaned as a logged consequence

A review of the plan documents ("Strategy Re-alignment — Brief vs Build, Gaps & Fix
Plan") found the original 5-step brief had drifted from what Control actually
implements across all 5 steps (10 gaps, G1–G10). Dharmin decided: build a new, literal
spec (`config/rules_literal.yaml`) as its own clean series, rather than re-interpret
Control in place. Full decisions and the reuse-vs-modify audit are in
`docs/literal-spec-plan.md`; this entry is the dated log record HARNESS.md rule 6
requires.

**D4 fixed.** `src/indicators/rsi.py`'s flat-series case (`avg_gain == 0 and
avg_loss == 0`) now returns 50 (neutral), not 100 — it was conflating "no losses, but
real gains" (correctly 100) with "no movement at all." `tests/test_indicators_properties.py::test_rsi_flat_series_is_neutral_not_100`
now passes; full `test_indicators.py`/`test_indicators_properties.py` suite (58 tests)
and the full repo suite (274 tests) stay green. This is a shared file — Control uses it
too — going forward only; no past record is re-graded (rule 4).

**Control winding down.** Per decision 2 in `docs/literal-spec-plan.md`, Control keeps
recording for 4–6 more weeks alongside Literal, then stops.
`tests/track_forward.py:CONTROL_WIND_DOWN` names a provisional last recording week
(2026-10-23) and prints a loud (non-blocking) warning if `record()` is ever called past
it — the actual stop is a human decision, not a test gate. Consequence, accepted
explicitly by Dharmin: the threshold experiment (`config/threshold_experiment.yaml`)
and the T4 flag-matrix arm (`config/feature_flags.yaml`) both derive every arm solely
from Control's own weekly picks file (HARNESS §12) and need 26 forward weeks to reach
their statistical gate; the threshold experiment has exactly 1 forward week recorded so
far. Neither can reach its gate before Control's recording ends. Both configs now carry
`status: orphaned_insufficient_forward_weeks` (outside their checksum-locked blocks) so
this shows up on read, not just in this log entry.

**Literal spec built** (`config/rules_literal.yaml`, `tests/track_literal.py`): full-NSE
universe (not the index-constituent proxy) from 2024 onward via a new
`_load_universe_full()` path in `src/data/adapter.py`, gated by
`universe.source: full_nse_equity_list` (Control's `index_lists` path is the untouched
default); no risk cap (`max_r_pct: null`, reusing `build_trades()` unmodified via
config); EP = Friday's signal close, not the following week's open (a new
`entry_price_source` param on `tests/track_forward.py:_grade_rows()`, default unchanged
for Control). Building this test surfaced and fixed a real latent bug: the gap-stop-at-
open check was comparing EP against SL, which is fine when EP == the following week's
open (Control today) but would have silently disabled gap-stop detection under the new
EP mode (EP there is fixed above SL by construction) — fixed to always check the actual
following week's open, regardless of which EP mode is active; the existing D7 test
(`test_d7_holding_week.py`) still passes unchanged, confirming Control's own behavior
didn't move.

**Not yet done, flagged for Dharmin:**
- The full-NSE daily backfill from 2024 itself hasn't run (a real, long, network-heavy
  pull — not something to run inside an interactive session). Until it does,
  `data_cache_literal/` is empty and `record()`/`grade()` will fail loudly rather than
  silently use Control's data.
- The full-equity-list endpoint was unreachable from the sandbox this was built in
  (Akamai bot-protection 503 — the same response the already-working index-CSV
  endpoints gave from that same sandbox at the same time, so this looks like a
  sandbox-network limitation, not a broken endpoint, but it has NOT been verified with
  a real fetch). Verify before trusting the first live Literal record.
- The VStop parity chart-check (JUBLPHARMA.NS, week ending 2026-09-11, stop-line
  ≈₹889.72) is still owed by Dharmin — apply VStop(10,2) to that chart and confirm.
- Dharmin should confirm the exact Control wind-down date (2026-10-23 above is a
  provisional placeholder, not a value Dharmin explicitly picked).

**Interim replay run (same day, after the above):** `python -m tests.track_literal
replay 12` — 12 weeks, 2026-06-29 .. 2026-09-14, over **Control's already-cached
index-proxy universe** (data_cache_literal/ still isn't backfilled; this is explicitly
NOT the full-NSE answer, just the other Literal corrections layered on the old
universe — see the loud notice `replay()` itself prints). 46 total picks across 11
weeks with data (2026-09-14 had 0 qualified survivors that week). Mean close-to-close
(the Q7 headline) +0.108%, mean net trade-result -0.392%, win rate 45.7% by
close-to-close. This is backtest/replay evidence only, written to
`results/literal_test/replay/literal_replay_2026-06-29_2026-09-14.csv` — never the
immutable `picks_*.json` forward-record path, and not to be read as validating or
invalidating anything after 12 weeks of backtest replay (HARNESS §10's 13/26-week gates
apply here too, and this isn't even forward evidence to begin with).

---

## 2026-09-26 — Full-NSE backfill run; T1 redefined onto Literal's universe; dashboard
## rebuilt around Literal + T1 only

**Full-NSE backfill completed**, resolving the blocker the previous entry flagged.
`scripts/bootstrap_literal.py` (new — a chunked, retried wrapper around
`scripts/common.py:bootstrap('config/rules_literal.yaml')`; a single ~2,300-ticker
`yf.download()` call reliably trips Yahoo's rate limiter, confirmed by a first attempt
that got only 1,474/2,317 tickers and 0/1,474 shares before being cut off) populated
`data_cache_literal/`'s universe list, weekly OHLCV, and shares outstanding: 2,317/2,317
tickers with weekly data, 2,214/2,317 (95.5%) with shares outstanding (the rest
genuinely have none published via yfinance, confirmed by re-querying, not a fetch
failure). `scripts/backfill_history.py` gained a `--config` flag (default
`config/rules.yaml`, Control's usage unchanged) and was re-run as `--config
config/rules_literal.yaml --start 2024-01-01`: 2,318/2,318 tickers (plus the benchmark),
zero missing, daily bars 2024-01-01 → 2026-09-25. This confirms the previous entry's
"sandbox network-egress limitation" read of the earlier 503 — the full-equity-list
endpoint is reachable from outside that sandbox.

One naming gap this surfaced: `tests/offline.py:OfflineAdapter._load_daily_panel()`
globbed only `daily_ohlcv_*d.parquet` (the live-path cache naming), so it couldn't find
`backfill_history.py`'s `daily_ohlcv_since_<start>.parquet` output for any cache_dir
other than Control's (where `ExtendedOfflineAdapter` already special-cased it). Widened
generically to prefer a `daily_ohlcv_since_*.parquet` file when present, falling back to
the live-path naming otherwise — covers `data_cache_literal/` too, no cache-dir-specific
subclass needed (HARNESS §2). New `env_literal_with_daily()` added alongside the
existing `env_with_daily()`.

**A second real, previously-latent bug**, caught the first time a real candidate was
scored under Literal's ruleset: `src/screen/candidate_score.py:guardrails()` computed
`risk_cap_pct * 100 - r_pct_of_close` unconditionally, assuming a numeric risk cap
always exists. Literal's `trade.max_r_pct: null` (decision: "a trade for every
qualified stock") made this `None * 100` → `TypeError`, crashing `score_row()` for
every T1-on-Literal candidate. Fixed: when `risk_cap_pct` is `None`, that guardrail
dimension contributes full credit (1.0) rather than crashing or discounting a
candidate against a constraint that doesn't exist. `risk_cap_headroom_pct` is `None` in
the output in that case, not a fabricated number. Regression test:
`tests/test_candidate_score.py::test_no_risk_cap_gives_full_headroom_credit_instead_of_crashing`.
Fixed going forward only; nothing past is re-graded (rule 4) — there was nothing to
re-grade, since this path had never successfully run before.

**T1 redefined onto Literal's universe** (Dharmin's decision): T1's existing daily
rolling-window scan (`src/screen/t1_scan.py:scan_t1_week()`) is unchanged — it was
already generic over `rule_spec`/`adapter`/`panels`. New `t1record()`/`t1grade()`/
`t1replay(start, end)` in `tests/track_literal.py` mirror `tests/track_forward.py`'s
existing `t1`/`t1grade`/`t1replay` exactly, just fed Literal's environment instead of
Control's, writing to `results/literal_test/t1_picks_*.json` and
`results/literal_test/replay/t1_*` (never mixed with Literal's own picks or Control's
T1 records). `tests/track_literal.py:replay()` was also rewritten to run over the real
`data_cache_literal/` universe now that it exists, instead of the interim
Control-proxy-universe stopgap the previous entry described; that stopgap's output
(`results/literal_test/replay/literal_replay_2026-06-29_2026-09-14.csv`) is left on disk
as a dated, superseded artifact, not deleted.

**Real retrospective replays run** (backtest evidence, never the immutable `picks_*.json`
forward-record path — HARNESS rule 4 — these score weeks after the outcome is already
known):
- `python -m tests.track_literal replay 142` — 142 weeks scanned, 131 with at least one
  pick, 2024-01-01 → 2026-09-14, real full-NSE universe. 892 total picks. Mean
  close-to-close (Q7 headline) −0.282%, mean net trade-result −0.719%, win rate 44.1%
  (close-to-close). 4 of 892 stopped out intraweek. Written to
  `results/literal_test/replay/literal_replay_2024-01-01_2026-09-14.csv`.
- `python -m tests.track_literal t1replay 2024-01-01 2026-09-14` — 142 weeks scanned,
  134 graded, same real universe. 2,871 confirmed-and-graded picks. Mean net −0.457%,
  win rate 41.3%, 561/2,871 (19.5%) stopped out. Written to
  `results/literal_test/replay/t1_ledger_grades.csv` (+ per-week manifests/CSVs).

Both are 100+ weeks of *backtest* evidence over a real universe — a large n, but not a
substitute for a pre-registered forward record, and not to be read as validating or
invalidating either arm (HARNESS §10's maturity gates are about forward weeks, and
neither of these is one).

**Dashboard rebuilt**: `docs/dashboards/test-vs-control-ledger.html` (filename kept
as-is, matching the existing skill/doc references, even though its content no longer
covers Control) now shows only the Literal spec and the T1-on-Literal replay above.
Removed: every Control-framed section (the frozen-spec table, the three weekly
funnel/grading write-ups, the four-arm Control/T1/T2/T3 comparison grid, the old
Control-universe T1 catch tables), the threshold-experiment section, and the T2/T3/T4
guardrail language — T2 and T3 were never anything but re-weightings of Control's own
trade list, and have nothing left to re-weight once Control isn't shown here; the
threshold experiment and T4 are unchanged in the codebase (still `status:
orphaned_insufficient_forward_weeks`, still deriving from Control's own forward-test
record, which keeps running independently of this dashboard) but are no longer
surfaced on this page. No generator script exists for this rebuild (per the
`rebuild-test-control-dashboard` skill) — assembled by hand from the CSVs above.

**Still open:**
- A real, pre-registered Literal forward record (`tests.track_literal record`/`grade`)
  still hasn't been logged — everything above is backtest replay.
- The VStop parity chart-check (decision 6, `docs/literal-spec-plan.md`) is still owed
  by Dharmin.
- Control's own forward-test record keeps recording independently through its
  provisional wind-down date (2026-10-23); this entry doesn't change that cadence, only
  what this one dashboard displays.

---

## 2026-09-26 — Literal's benchmark changed to Nifty 50; return-performance-vs-benchmark
## tracking added

**Benchmark changed** (Dharmin's decision, same day as the entry above):
`config/rules_literal.yaml`'s `sector.benchmark`/`benchmark_ticker` moved from
`NIFTY_MIDCAP_150`/`NIFTYMIDCAP150.NS` to `NIFTY_50`/`^NSEI` — tracking Literal/T1's own
return performance against the broad market, not a mid-cap-specific index. Confirmed
`^NSEI` is a real, reachable ticker (`NIFTY50.NS` and `^CNX50` both return no data).
Literal-only: Control's `config/rules.yaml` keeps `NIFTYMIDCAP150.NS` unchanged
(HARNESS rule 1). `^NSEI`'s weekly and daily bars were fetched directly into
`data_cache_literal/`'s existing parquet files (merged in, not a fresh full backfill).

This ticker feeds two things: sector relative-strength scoring (now vs Nifty 50) and a
**new** per-week "our basket vs the benchmark" comparison — `_benchmark_week_return()`,
a new shared helper in `tests/track_literal.py` (the benchmark's own open-to-close
return over the same holding week our trades are scored against), now used by
`grade()` (refactored to call it instead of inlining the same logic — it existed there
before but had never actually run, since the old benchmark ticker was never in
`data_cache_literal/`'s weekly cache either), and newly added to `replay()` and
`t1replay()`, which previously had no benchmark comparison at all. Trade selection and
P&L (EP, SL, exit price, `ret_pct`/`ret_pct_net`) are unaffected by the benchmark —
only sector scoring and this new comparison line.

**Both replays re-run** against the new benchmark (same 142-week window,
2024-01-01 → 2026-09-14 — trade-level numbers unchanged from the prior entry, as
expected):
- Literal: mean Nifty 50 return +the week's own move, mean **−0.018%**/week
  (holding-week open-to-close); mean alpha vs benchmark **−1.029%**; beat the
  benchmark in **42/131** weeks (32.1%).
- T1-on-Literal: mean Nifty 50 **+0.042%**/week; mean alpha **−0.668%**; beat the
  benchmark in **51/134** weeks (38.1%).

Neither series beats Nifty 50 on average over this backtest window — logged as a
finding, not acted on (HARNESS §10: no arm is judged before its statistical gate, and
this is backtest replay, not even forward evidence to begin with).

**Dashboard updated**: `docs/dashboards/test-vs-control-ledger.html`'s per-week tables
for both arms gained "vs Nifty50" and "Alpha" columns, plus three new headline stats
each (mean benchmark, mean alpha, weeks beating benchmark). A caveat was added noting
"alpha" here is a plain return difference, not risk/beta-adjusted.

---

## 2026-09-27 — Residual D7-adjacent defect fixed; Literal registered in v0.7 plan;
## Phase 5 / Step-5-extended work started

**Residual defect fixed.** The zero-volume placeholder row `corrected_week_bar`
(`src/data/holding_week.py`) could still pick up on a holiday Monday — flagged but not
fixed in the 2026-09-14-week entry above — is now filtered out before open/low/close
are read off the week's real sessions (`days["volume"].fillna(0) > 0`). If a week's
daily panel has no real (nonzero-volume) session at all, the function now falls back to
the weekly bar unchanged rather than silently treating the placeholder as real.
`tests/test_d7_holding_week.py` gained two cases
(`test_holiday_monday_zero_volume_placeholder_row_is_skipped`,
`test_all_placeholder_rows_falls_back_to_weekly_bar`); the full suite (7 tests) passes.
No past record is re-graded (rule 4) — this changes behavior going forward only.

**Literal registered.** `docs/forward-test-response-and-volume-plan.md` (v0.7) gained
§3.11, describing Literal the same way §3.9/§3.10 describe T4 and the threshold
experiment, with one explicit difference stated up front: Literal is not a Test arm and
§3.5's graduation gate does not apply to it — it is a second, parallel, frozen
implementation of Dharmin's own five-step brief, not a candidate competing for
Control's capital. `CLAUDE.md` was updated to describe the Literal series in its
architecture map and current-in-flight-state section (it was previously undocumented
there despite being on disk since 26 Sep), and to correct two stale lines: D7 has been
fixed since 16 Sep and D4 since 26 Sep, not "awaiting Dharmin's decision" as the file
still said.

**Still open, unchanged by this entry:**
- A real, pre-registered Literal forward record still hasn't been logged.
- The VStop parity chart-check (decision 6, `docs/literal-spec-plan.md`) is still owed
  by Dharmin.
- T1 is not yet redefined as the rolling-Friday-window loop the Literal spec calls for
  (`src/screen/t1_scan.py` is still the single-week scan); work on this and on the new
  "Step 5 extended" 1-/2-/3-week horizon grading (trailing-stop trade view decided by
  Dharmin this session) is starting now, in this same session.

---

## 2026-09-27 — T1 redefined; Step 5 extended (1-/2-/3-week horizon grading) built;
## full test suite green (306 passed)

**T1 redefined**, per the "T1 redefined per the brief" section above: the old mid-week
scan is frozen and no longer called T1 (`tests/track_literal.py`'s
`midweek_scan_record()`/`midweek_scan_grade()`/`midweek_scan_replay()`, same
`src/screen/t1_scan.py:scan_t1_week()` scan code, unchanged, just renamed). T1 now means
Literal's own rolling weekly loop: every graded week (`grade()`, live) or replayed week
(`replay()`, history) builds an identical row (`_ledger_row()`) and appends it to
`results/literal_test/rolling_ledger.csv` (`_append_rolling_ledger()`, skip-if-present —
a week already in the ledger is never overwritten); `rolling_stats()` reads the latest
week plus rolling 4-/13-/26-week aggregates (mean close-to-close, mean trade-result net,
win rate, mean alpha vs benchmark) off that one ledger, called identically by both the
live path and the replay path (`python -m tests.track_literal rolling`).

**Step 5 extended built**: `config/rules_literal.yaml` gained
`validation.horizons_weeks: [1, 2, 3]`. `src/backtest/horizons.py:grade_horizons()`
grades every pick at every configured horizon in two views — signal (close-to-close)
and trade (stop trails to each week's own closed VStop line, decided by Dharmin this
session; once the stop is hit the exit price freezes and carries forward unchanged to
later horizons, exactly as the brief specifies). It reuses `corrected_week_bar()` (the
D7 fix) for every week's open/low/close and `compute_vstop()` for the trailing line; it
does not fork or reuse `simulate_trend_hold()` as-is, because that function's EP is the
following week's open (Control's convention, not Literal's signal-close EP) and it also
exits early on a trend flip-down, which this fixed-horizon feature does not do (only a
stop counts). `tests/track_literal.py:maturity_loop()` grades every still-open cohort
and appends only newly-matured `(ticker, horizon, view)` rows to
`results/literal_test/horizons/<record_id>.jsonl` — append-only, idempotent (confirmed
by test: running it twice produces byte-identical output), never touching the original
`picks_<date>.json`. `replay_horizons()` calls the identical `grade_horizons()` swept
over history instead, to
`results/literal_test/replay/horizons_replay_<start>_<end>.jsonl` — not yet run for
real (needs the full daily-bar backfill from 2024-01-01, a long network-heavy pull, same
caveat as Literal's own `replay()`). `src/backtest/stats.py` adds `block_bootstrap_ci`
(3-week blocks, since 2- and 3-week windows from consecutive Fridays overlap and are not
independent) and `nonoverlapping_sanity` (every 3rd Friday only, plain i.i.d.
`bootstrap_ci`) — reported side by side, never merged into one number.
`tests/track_literal.py:weekly_report()` assembles the doc's 5-step weekly report
(universe funnel, qualified stocks, sector view, trades, last-3-weeks-graded plus
rolling totals) purely by reading what `record()`/`grade()`/`maturity_loop()`/`rolling()`
already produced — no re-screening, no re-grading.

**Residual D7-adjacent defect also fixed this session** (see the entry above this one
for detail) — `corrected_week_bar()` now skips a holiday Monday's zero-volume
placeholder row instead of reading its open as if it were a real session.

New tests: `tests/test_leakage.py::test_grade_horizons_future_mutation_canary` (+3
related), `tests/test_horizons.py` (6 behavioral tests — trailing-stop mechanics,
freeze-on-exit, step returns, benchmark/excess, missing-panel handling),
`tests/test_t1_rolling_window.py` (6), `tests/test_maturity_loop.py` (3),
`tests/test_horizon_stats.py` (6), `tests/test_weekly_report.py` (2),
`tests/test_d7_holding_week.py` (+2). Full suite: **306 passed, 1 skipped**, no
regressions from the T1 rename (verified by re-running the full suite before and after).

**Still open, unchanged by this entry:**
- A real, pre-registered Literal forward record still hasn't been logged (Dharmin's
  decision — code is ready, the first live `record()` is triggered manually).
- The VStop parity chart-check (decision 6, `docs/literal-spec-plan.md`) is still owed
  by Dharmin.
- Two follow-on sub-decisions from the "Step 5 extended" section remain open:
  whether the headline horizon stays "report all three, pick none" (the doc's own
  suggested default), and nothing here re-litigates the still-unresolved flip-direction
  reporting gap (G3) or the VStop-parity gap (G4) — those are Phase 0/2 items, not
  touched by this entry's Phase 5 / Step-5-extended scope.
- `replay_horizons()` has not been run over real history yet (see above).

---

## 2026-09-27 — Retrospective review: Control's 2026-09-14 week reconstructed;
## Control `grade()` bug found (zero-survivor crash); Literal horizon-replay run for real

**Control's 2026-09-14 week reconstructed, not recorded.** Investigating this
retrospective found `results/forward_test/` had no main Control record for signal week
2026-09-14 at all — only the T1 shadow scan. `tests/track_forward.py:record()` always
operates on `all_dates(panels)[-1]` (whatever week is currently latest); by the time
this was noticed, the live cache had already moved past that date, so `record()` can no
longer target it. `scripts/reconstruct_control_week.py` reconstructs it instead, using
the same `run_screen()`/`build_trades()`/`score_row()` primitives with `as_of` pinned to
2026-09-14 — this is unavoidably **hindsight** (the outcome is already known), so the
record is tagged `"recording_mode": "reconstructed_after_the_fact"`, distinct from this
codebase's existing `late_backfill` label (a few hours/days late, not weeks-later
reconstruction). **Result: a genuinely empty week.** Funnel:
`candidate_universe=501 -> market_cap_band=259 -> liquidity=259 -> vstop_flip=0 ->
survivors_after_rsi_band=0`. Zero bullish VStop flips in Control's entire index-proxy
universe that Friday — not a risk-cap or RSI-band rejection, nothing flipped at all.
Zero survivors, zero near-misses, zero trades. Benchmark comparison also came back
`null` — Control's local `data_cache/` has no cached `NIFTYMIDCAP150.NS` series
covering this date, a separate, pre-existing data gap not investigated further here
(out of scope for this task; flagged for whoever next touches Control's benchmark
fetch). Per HARNESS rule 4, this reconstructed record does **not** retroactively fill
or edit anything, and does not count toward any statistical gate that requires
forward-mode weeks.

**Bug found, not fixed (Control's file is frozen, HARNESS rule 1):**
`tests/track_forward.py:grade()` crashes (`KeyError: 'status'`) on a week with zero
survivors AND zero near-misses — `pd.DataFrame([])` has no `status` column, and
`grade()`'s `df[df["status"] == "TRADE"]` assumes one always exists. This week's
`graded` summary was constructed by hand in `scripts/reconstruct_control_week.py`
instead of calling the real `grade()`, to avoid depending on a crash-prone path. Any
future week with truly zero qualified stocks (before risk-cap filtering) will hit the
same crash if graded normally — worth a real fix, but that's a deliberate Control-file
change for Dharmin to authorize, not something folded into this retrospective.

**Literal's horizon-grading replay run for real, first time.** `python -m
tests.track_literal replay_horizons 2024-01-01 2026-09-21` — the first real execution
of last session's `grade_horizons()`/`replay_horizons()` (built but never run against
real data) over the full-NSE cache in `data_cache_literal/` (270 cached weeks back to
2021-07-26 for indicator warm-up; Literal's own history starts 2024-01-01 per decision
1). Output: `results/literal_test/replay/horizons_replay_2024-01-01_2026-09-21.jsonl`.
Backtest replay evidence only (HARNESS rule 4) — not forward evidence, however real the
underlying universe and prices now are. 5,346 graded rows (143 weeks × up to 3
horizons × 2 views). Aggregated per (week, horizon, view) and fed to
`src/backtest/stats.py:block_bootstrap_ci`/`nonoverlapping_sanity` via a new one-off
script, `scripts/extract_literal_horizons_dashboard_data.py` (same pattern as the
existing `scripts/extract_wow_dashboard_data.py`). **Headline result: every
confidence interval, at every horizon (1/2/3 weeks), both views (signal/trade),
straddles zero** — mean per-week returns are all negative (−0.45% to −0.88%) but the
block-bootstrap and non-overlapping-sanity CIs both include zero at every horizon. Per
HARNESS §10, this is not evidence of negative edge and not evidence against it — 131
weeks of mostly single-digit-name weekly baskets isn't enough to resolve a signal this
size. Full table:
`docs/dashboards/test-vs-control-ledger.html` new §04 ("Step 5 extended").

**Dashboard rebuilt** (`docs/dashboards/test-vs-control-ledger.html`): new §04 inserted
between the existing §02 (Literal replay) and §03 (T1 replay) → §04 → renumbered §05
(caveats). Per its own skill's guardrails
(`.claude/skills/rebuild-test-control-dashboard/SKILL.md`): numbers read directly from
`replay_horizons()`'s own output (never recomputed by hand), labelled "backtest
evidence, not forward" with the same pill styling as §02/§03, existing CSS/fonts
reused. One explicit new caveat added: §04's numbers are **per-week means** (equal
weight per week, matching the unit the CIs are computed over), not §02/§03's per-pick
pooled means — the two conventions coexist on this page and are not directly
comparable line-for-line.

**Test regression found and fixed** (byproduct of reconstructing 2026-09-14):
`tests/test_wow.py::test_lane_c_append_one_row_per_week_no_mutation` hardcoded
`"2026-09-14"` as a synthetic "new week" filename to test that Lane C's panel-builder
appends one row per newly-added record. That date collided with the real, now-existing
`results/forward_test/picks_2026-09-14.json` — the test's `tmp_path` copy of the real
directory already contained a 2026-09-14 record, so writing "a new" file at that same
name overwrote it in place instead of adding one, and the append-count assertion
started failing. Fixed by using a synthetic far-future date (`2099-01-04`) that can
never collide with a real signal week. Full suite: **308 passed, 1 skipped** after the
fix (was 307 passed, 1 failed, 1 skipped before it).

**§04 extended with the same two views §02/§03 already use** (per Dharmin's follow-up
request): a full "every week" per-week table (signal and trade views, 131 weeks each)
and a "most recent 8 weeks, ticker-level detail" table (trade view, 41 picks) showing
each ticker's R1w/R2w/R3w and its latest-graded exit status. New one-off script,
`scripts/build_horizons_dashboard_tables.py`, renders these directly from
`horizons_replay_2024-01-01_2026-09-21.jsonl` in the exact `<tr>` shape/CSS classes §02
already uses — no new styling. Caught and fixed two bugs while building it: `_fmt_pct`
returned a bare `&mdash;` (no `<td>` wrapper) for an ungraded horizon, breaking the
table structure; and the ticker-detail table's "exit" column read `sl_hit_week` with a
truthiness check that treated `NaN` (Python: `NaN` is truthy) as a real value,
printing "open (nan)" instead of a plain "open". Both fixed before the data was
spliced into the dashboard; verified by re-rendering and visually checking the
in-app browser preview.

**§04 gained a trend-line chart** (Dharmin's follow-up): "our basket vs Nifty 50"
mean weekly return, one small-multiple line chart per horizon (1w/2w/3w), trade view,
131 weeks. Not a compounded/cumulative equity curve — 2- and 3-week windows from
consecutive Fridays overlap, so compounding them would double-count weeks; only the
raw per-week mean return is plotted (`scripts/build_horizons_dashboard_tables.py
trend_data`, folded into the existing table-building script rather than a new one).
Charting reuses `docs/dashboards/wow-trend-dashboard.html`'s `lineChart()` function
verbatim (same hover crosshair + tooltip, same gridline/zero-line/axis-line CSS
classes) — this dashboard had no charting code before, only static tables, so this
is the first `<script>` this file has ever needed. Per the `dataviz` skill: chose
the categorical pair blue (`#2a78d6`/`#3987e5`) for "our basket" and orange
(`#eb6834`/`#d95926`) for "Nifty 50" from the skill's documented default palette
(slots 1-2, fixed order, never cycled) and validated it against this page's actual
panel-surface colors with `validate_palette.js` — all checks pass in both light and
dark mode (worst-pair CVD ΔE 24.7 light / 26.8 dark, well above the 8.0 target).
Legend always shown (2 series); a table view already exists directly below each
chart (the per-week tables added earlier this session) satisfying the skill's
accessibility requirement. Verified interactively in the in-app browser: all three
charts render with two distinguishable lines, the hover tooltip reports the correct
per-week values (spot-checked against the underlying data), and the page's HTML tag
balance stays valid.

---

<!-- flags-audit:2026-09-21:2dc46408f8b9f42c -->

## 2026-09-21 flag-matrix audit (mode: late_backfill)

Full record: `results/feature_flags/flags_2026-09-21.csv`, audit:
`results/feature_flags/audit/audit_2026-09-21.json`

- Overall: **FAIL**
- Eligible rows: 262, T4 picks: none
- Control trades this week: none
- Noteworthy reasons: check_failed, recording_mode_late_backfill

No graded week yet.

---

## 2026-09-21 signal week — Literal series' first live record, and a manually-curated shadow basket ("T1-extra selected")

Same signal week as above (entry Monday 2026-09-28), a different spec. Two things
happened here, both same-day/late relative to Monday's open (recorded ~20:34 IST
2026-09-28), so neither counts as a blind pre-open forward test — informational only.

**Literal's own first live record** (`results/literal_test/picks_2026-09-21.json`,
`record_id=lit_2026-09-21`): 2 survivors, both traded (Literal has no 15% risk-cap
guardrail, unlike Control) — HBLENGINE.NS (EP 806.0) and WHIRLPOOL.NS (EP 918.9). These
are the same two tickers Control's own screen found and then rejected via its risk-cap
guardrail — Control traded zero this week. First live illustration of the two specs
diverging on the same signal.

**Frozen midweek_scan (old T1, run under Literal's rules)** confirmed 21 extra names
beyond Control/Literal's own survivors at Friday 2026-09-25 close
(`results/literal_test/t1_picks_2026-09-21.json`, `record_id=lit_2026-09-21_t1`) — shadow
only, zero graded weeks, not eligible for real capital.

**Manual curation on top of that scan** (Dharmin's request, 2026-09-28): recompute
VStop(10,2)/RSI(14) on daily bars extended one bar to Monday 2026-09-28's actual
opening print (open=high=low=close=open, since only the open — not the full day — was
available), to sanity-check whether Friday's confirmed names still held up at the
week's actual entry point. One name, CLEANMAX.NS, gapped down through its own stop
(Fri close 1393.40 → Mon open 1303.00; SL flips from 1321.23 to 1451.08, RSI drops
from 56.08 to 46.55, outside [50,65]) — excluded. The remaining 20 are tracked as a
shadow basket in a new, separate record, `results/literal_test/t1_extra_selected_2026-09-21.json`
(`record_id=lit_2026-09-21_t1_extra_selected`) — the original 21-name scan record is
left untouched (HARNESS §4), this is a derived file, not an edit.

EP for grading is Friday's signal_close (same convention as the rest of this series —
Monday's open is a fill-reality check, not the official entry price), so CLEANMAX.NS's
near-immediate stop-out is honest evidence if it had been included, not a reason to
pretend it wasn't picked; it was excluded prospectively, before any grading, on the
rule's own terms (flip_down + RSI outside band), not after seeing a bad result.

Grading plan: 1-week via `python -m tests.track_literal midweek_scan_grade
results/literal_test/t1_extra_selected_2026-09-21.json` (reused verbatim, it only reads
generic keys) once the week of 2026-09-28 closes; 2-/3-week via a new thin driver,
`scripts/track_t1_extra_horizons.py`, that reuses `grade_horizons()` verbatim
(`maturity_loop()` itself only globs the main `picks_*.json` cohorts, not this
basket's differently-named file, by design). Dry-run today correctly produced 0 graded
rows / 120 pending (20 tickers × 3 horizons × 2 views) — nothing has matured yet.

**Important standing caveat, repeated because it's easy to lose in the mechanics above:**
this whole basket is shadow-only. It is not a registered Test arm, has no graded
history, and per `docs/forward-test-response-and-volume-plan.md` is nowhere near
eligible to touch real capital. Tracking it is legitimate evidence-gathering; treating
it as an executed trade list would not be.

---

## 2026-09-28 — VStop(10,2) TradingView parity check (decision 6, closed)

Dharmin shared a TradingView screenshot of KAYNES.NS's weekly chart: `VStop 10 close 2`
read 3311.7. This session had separately quoted 3383.48 / 3394.82 for KAYNES.NS (from
the midweek_scan basket above), so it looked like a ~2.5% gap — `docs/literal-spec-plan.md`
already flagged a VStop-vs-TradingView parity check as an open to-do ("decision 6",
never done). Investigated with a new diagnostic-only script,
`scripts/vstop_parity_check.py` (no production code changed).

**Root cause: a comparison error, not a defect.** The 3383/3394 figures were the
*daily-bar* VStop (`src/screen/daily_scale.py`'s T1/midweek-scan path — VStop(10,2)
applied to **daily** bars, i.e. a 10-trading-day, ~2-week lookback) — a different,
faster indicator from the **weekly** VStop(10,2) (10-week lookback) that
`config/rules_literal.yaml` and TradingView's chart both use. Comparing them was
apples-to-oranges.

Weekly-vs-weekly: our last-*closed*-week reading (Fri 2026-09-25) was 3265.08 — still
not 3311.7, because the screenshot was taken while the *current* week (2026-09-28) was
still open, and TradingView plots VStop live against the in-progress week's own
OHLC-so-far, not the last closed week's. Extending our own weekly panel with that same
in-progress week's elapsed daily bar (fetched fresh: O=3623.80 H=3695.00 L=3589.00
C=3658.00 — verified to match the TradingView candle exactly, one trading day so far)
and recomputing gives **3311.68** — matches to the cent.

Also tested and ruled out as contributing factors, so they're not just unexamined:
- **ATR seeding**: `wilder_atr()`'s EMA-from-bar-1 vs a textbook SMA-seeded Wilder ATR —
  delta 0.0000 on 201 weeks of history. Any seed-choice difference decays away well
  before 201 periods at this smoothing rate.
- **History window length**: 260w vs 130w vs 104w cached history — deltas under 0.004,
  i.e. negligible sensitivity to where the recursion starts, at least at these depths.

**Outcome: no code change needed or made.** `src/indicators/vstop.py:compute_vstop()`
is now verified against a real chart on a like-for-like basis (same ticker, same week,
same OHLC) — decision 6 in `docs/literal-spec-plan.md` is closed. `scripts/vstop_parity_check.py`
is kept as a reusable tool for any future spot-check (`python -m scripts.vstop_parity_check TICKER`).

---

## 2026-09-28 — second shadow basket: the same 21 names, re-screened under the correct WEEKLY rule as of Monday's open

Follow-on from the VStop parity check above. Once the daily-vs-weekly VStop distinction
was clear, the natural question was: of the 21 names the frozen midweek_scan confirmed
(daily-bar VStop+RSI), how many would actually pass the real, weekly VStop(10,2)/RSI(14)
rule (the one Control/Literal/TradingView all use) if re-evaluated live using Monday
2026-09-28's actual opening print as the current week's only data point so far?

Computed weekly VStop and RSI(14) for all 20 names still tracked (CLEANMAX.NS already
excluded separately, see the entry above) extended with Monday's open only
(open=high=low=close=open). Result: **only 8 of 20 pass both predicates**
(uptrend AND RSI in [50,65]) — ANANTRAJ.NS, COHANCE.NS, CPPLUS.NS, EDELWEISS.NS,
GABRIEL.NS, IIFL.NS, SHYAMMETL.NS, URBANCO.NS. The other 12 fail: APOLLO.NS,
EMAMILTD.NS, JMFINANCIL.NS, MANAPPURAM.NS aren't in a weekly uptrend at all (they
only ever showed up via the daily-bar scan); AEQUS.NS, CAPLIPOINT.NS, INDGN.NS,
INOXINDIA.NS, KTKBANK.NS, NAZARA.NS, WOCKPHARMA.NS are trending but RSI has already
run past 65; KAYNES.NS's RSI is just under 50. Not a bug — this is the expected
consequence of the daily scan being a faster, noisier indicator by construction; now
there's a concrete number (8 of 20, not 20 of 20) for how much they actually agree.

Dharmin asked to track this 8-name basket separately, same 1-/2-/3-week discipline as
the 20-name one. New record: `results/literal_test/weekly_rule_selected_2026-09-28.json`
(`record_id=wk_monday_open_qualified_2026-09-28`). Entry price is Monday's actual
opening print (not a Friday close, despite reusing the `signal_close` field name for
tooling compatibility) — `signal_close`: ANANTRAJ 615.00, COHANCE 459.25, CPPLUS
3759.90, EDELWEISS 138.33, GABRIEL 1386.70, IIFL 609.90, SHYAMMETL 1085.00, URBANCO
168.99; `vstop_line_SL` is the VStop line computed at that same Monday-open-extended
bar. `signal_week_start` is deliberately set to `2026-09-21` (the last real closed
week already in the cache), not `2026-09-28` — both grading paths look for the first
panel bar *after* `signal_week_start`, so this correctly anchors entry to the week of
2026-09-28 once it closes, using this record's own `signal_close` (Monday's open) as
the fixed EP rather than that week's eventual close.

Grading reuses existing tooling verbatim, no new code: 1-week via
`python -m tests.track_literal midweek_scan_grade results/literal_test/weekly_rule_selected_2026-09-28.json`;
2-/3-week via `python -m scripts.track_t1_extra_horizons results/literal_test/weekly_rule_selected_2026-09-28.json`
(the same driver built for the 20-name basket). Both dry-ran clean today: 1-week
correctly reports "no forward bar yet" (week hasn't closed), 2-/3-week correctly
reports 0 graded / 48 pending (8 tickers × 3 horizons × 2 views). Maturity: 1w after
Fri 2026-10-02, 2w after Fri 2026-10-09, 3w after Fri 2026-10-16.

Same standing caveat as the 20-name basket: shadow-only, not a registered Test arm, no
graded history, not eligible for real capital.

---

## 2026-09-29 — RSI(14) parity check: a real seeding gap, but only for short-history tickers

Follow-on from the VStop parity work. For URBANCO.NS, week of 2026-09-21 — a bar already
confirmed identical to TradingView's own candle (raw-data mismatch ruled out) — TradingView's
RSI(14) reads 64.57, ours reads 62.99 (a 1.58-point gap). Unlike the VStop case, this looked
like a genuine methodology difference rather than a comparison error, so it was investigated
with a new diagnostic-only script, `scripts/rsi_parity_check.py` (mirrors
`scripts/vstop_parity_check.py`; no production code changed).

**Confirmed: `src/indicators/rsi.py:compute_rsi()`'s seeding (`ewm(alpha=1/period,
adjust=False)` from bar 1, no separate SMA-seed step — the same class of shortcut already
found and ruled out for `vstop.py:wilder_atr()`) genuinely matters here, unlike for VStop.**
A textbook Wilder-seeded variant (simple average of the first 14 gains/losses, then RMA
recursion from bar 14 onward), run over the identical panel, gives **64.5667** — matching
TradingView's 64.57 to within 0.003.

**The key nuance: it depends entirely on how much history is available.**
- URBANCO.NS has only **54 cached weekly bars** (IPO'd ~2025-09-15) — seed choice hasn't
  decayed away yet at α=1/14, so it materially biases the reading (+1.58 here).
- KAYNES.NS, cross-checked as a control with 201 weeks of history: seeding delta is
  **0.0000** — identical result either way, same pattern already found for VStop's ATR.

So this isn't a universal bug — it's a **short-history-ticker-specific bias**, and any recently
listed stock (IPO within the last ~2 years) in the universe is exposed to it; established
mid-caps with long history are unaffected either way.

**Not fixed — deferred, per the same discipline as the VStop investigation.** Unlike VStop's
stop-*level*, RSI is a hard **pass/fail band filter** (`50 <= rsi <= 65`) used by every
historical screen/backtest/replay/experiment (Control, Literal, T1, threshold experiment, flag
matrix, wow analysis). A biased RSI near a band edge can flip whether a short-history stock
passed the screen at all, in every past week it appeared — a much larger blast radius than
VStop's would have been. Fixing `compute_rsi()`'s seeding would require re-running every
downstream artifact per `.claude/HARNESS.md`'s re-run rule and could shift historical picks
(not just their P&L), so this is left as a diagnosed-but-unfixed, explicitly flagged item
pending Dharmin's decision on whether/when to take that on. `scripts/rsi_parity_check.py` is
kept as a reusable tool (`python -m scripts.rsi_parity_check TICKER`).

---

## 2026-09-29 — RSI(14) seeding fixed to match TradingView; every downstream artifact re-run

Dharmin decided to adopt the TradingView-matching seeding confirmed above. Implemented and
re-run this session.

**Fix**: `src/indicators/rsi.py:compute_rsi()` — replaced `gain.ewm(alpha=1/period,
adjust=False, min_periods=period).mean()` (seeded from bar 1) with a textbook Wilder recursion
(`_wilder_smooth_sma_seeded()`): seed at bar `period` with a simple average of the first
`period` gains/losses, then `avg[i] = (avg[i-1]*(period-1) + x[i]) / period` from there. Same
function signature, same D4 flat-series-neutral-50 logic, same RS/100 conversion — only the
seeding changed. Added a real reference-value test,
`tests/test_indicators.py::test_rsi_matches_tradingview_reference_short_history_ticker`
(URBANCO.NS's actual 54-week close series → 64.57, matching TradingView to within 0.01) — the
first time `compute_rsi()` has ever been checked against a real external value; previously
documented as an open limitation. Full suite: **309 passed, 1 skipped** (no change in pass
count — no regressions).

**Immutable records untouched, per HARNESS §4 and the D4 precedent** (fix applies going
forward only): every `results/forward_test/picks_*.json`, `results/literal_test/picks_*.json`
(including this session's own `t1_extra_selected_2026-09-21.json` and
`weekly_rule_selected_2026-09-28.json`), `results/feature_flags/flags_*.csv`,
`results/threshold_experiment/threshold_*.json`.

**Regenerable backtest artifacts re-run with the fixed RSI:**

1. **Control's 104-week walk-forward** (`scripts/run_backtest.py`, 2024-09-30 → 2026-09-21):
   239 trades / 73 weeks (of 104 folds), 36.8% hit rate, expectancy **-1.24%/trade** (was
   -1.07% originally, then -1.285% after the 2026-09-16 D1–D6 restatement — this is now a
   third, current number), portfolio CAGR -43.15%, Sharpe **-2.07** (was -2.6, then -2.24),
   max drawdown **-70.57%** (was -50%, D1–D6 restatement not separately recorded).
   `README.md` and `CLAUDE.md` updated to this figure; `README.md` also flags that its
   trend-hold and RSI-band-sensitivity sub-studies were **not** re-run this round (still
   reflect the pre-fix, pre-104-week numbers — stale until separately redone).
2. **Literal spec's `replay_horizons()`** (2024-01-01 → 2026-09-21, full-NSE universe): 5352
   graded rows across 143 weeks (was 5346 before the fix — RSI band membership shifted for a
   handful of ticker-weeks, mostly short-history names, as expected). Trade-view aggregate
   means: 1w -0.228%, 2w -0.148%, 3w +0.181% (signal-view: -0.291%/-0.170%/+0.323%). Output:
   `results/literal_test/replay/horizons_replay_2024-01-01_2026-09-21.jsonl` (overwritten in
   place — this file is backtest evidence, not an immutable record, consistent with the file's
   own docstring: "a full, deterministic rebuild each run"). **Not re-run**: the Literal
   `replay()` (plain N-week backtest, separate from `replay_horizons()`) and
   `midweek_scan_replay()` — lower priority, flagged as optional follow-up.
3. **Flag matrix's 104-week replay** (`tests/track_flags.py replay --start 2024-09-09 --end
   2026-09-21`): 107 weeks, 107 graded, ~5m14s runtime, all cache-driven (no network needed for
   this step). Scorecard regenerated (`scorecard --mode replay`) — same qualitative picture as
   before (only `B05_trend_quality_strong` significant after Benjamini-Hochberg correction,
   `flags_met` rank-IC 0.0076, not significant). **T4 DEV/VALIDATE calibration re-run**
   (`t4-calibrate`): kill criterion (a) still triggers — same conclusion as before this fix,
   `config/feature_flags.yaml`'s `t4.k` correctly stays `null`. Numbers shifted slightly (e.g.
   DEV k=7 mean weekly net -0.7484%, VALIDATE -0.4188%) but the decision is unchanged.

**Not re-run, explicitly flagged as follow-up** (per the plan's stated lower priority):
`config/experiments.yaml`'s V2/V3/V4 and guardrail-calibration variants
(`scripts/run_v2_backtest.py`, `scripts/run_v3_v4_backtest.py`). The threshold experiment and
`src/wow/` week-over-week study were confirmed **not** affected (both derive only from
already-recorded/graded picks, never call `run_screen()` fresh) — nothing to re-run there.
`docs/dashboards/test-vs-control-ledger.html` (hand-maintained, per its own skill) now reflects
the pre-fix Literal-replay numbers in its §04 tables/charts — stale until next rebuilt via the
`rebuild-test-control-dashboard` skill.

---

## 2026-09-29 (continued) — dashboard §04 rebuilt; trend-hold, RSI-band study, V2/V3/V4 re-run

Follow-up to the RSI fix above, same day. Three remaining flagged items, all done:

**§04 dashboard rebuilt** with the refreshed `horizons_replay_2024-01-01_2026-09-21.jsonl`
(5352 rows). Used the skill's own procedure: `scripts/extract_literal_horizons_dashboard_data.py`
for the summary table (both signal/trade views, all three horizons — deltas tiny, e.g. 1w
signal mean -0.561%→-0.565%, consistent with the small row-count change), then
`scripts/build_horizons_dashboard_tables.py tables`/`trend_data` for the two 131-week
"every week" tables, the 41-pick "most recent 8 weeks" ticker-detail table, and the
`HORIZON_DATA` trend-chart JS blob — all spliced in by locating each `<tbody>`/`<script>`
block via its preceding `card-head` text (row counts and tag balance verified after: 131/131/41
rows, `<table>`/`<tbody>`/`<tr>`/`<script>`/`<div>` all balanced). `.claude/skills/rebuild-test-control-dashboard/SKILL.md`
updated additively (nothing removed) to document that §04 now has generator scripts (unlike
§02/§03, which still don't) and to record this fix-triggered-rebuild as a second trigger
alongside "new graded week."

**Control's trend-hold secondary exit re-run** (`scripts/run_backtest.py --trend-hold`,
same 104-week window as the primary restatement above) — previously flagged in `README.md` as
not re-run. **This one is a material, not cosmetic, change**: same 239 trades, held 11.09 weeks
on average (median 9.0), but hit rate dropped to 28.9% (was 45.7% pre-fix/52-week) and — unlike
the pre-fix run's "mean-positive, median-negative" story — the mean per-trade annualized return
is now also negative (-16.4%, was +17.0%; median -31.3%, was -4.9%; std 86.5%, was 104%). 82.0%
of trades exit via stop (was 72.8%). Two things changed at once here (RSI fix + window
52→104 weeks), so this isn't a clean isolation of the RSI fix's own effect — but either way,
the qualified silver lining the old numbers offered ("a few large winners carry a positive
mean") no longer holds on this window. `README.md` updated to the new numbers and bottom line.

**RSI-band sensitivity study (`scripts/rsi_param_study.py`) — still running as this entry is
written**; `README.md` currently flags it explicitly as stale/pending rather than silently
carrying the pre-fix 52-week numbers as if current. Will be appended as its own dated entry
once it completes, per append-only discipline (not edited into this paragraph after the fact).

**V2/V3/V4 dev backtests re-run** (`scripts/run_v2_backtest.py`, `scripts/run_v3_v4_backtest.py`)
— both read/write only the `dev` segment, which `src/data/segments.py` marks `one_pass: False`,
so a second read for a legitimate bug-fix rerun is allowed (unlike `holdout_ext`, which is hard
one-pass). Logged as new rows in `results/evidence/segment_reads.csv`, same as their first run.
Same qualitative conclusions as before the fix, numbers refreshed:
- V2: kill criterion ("no N with net expectancy > 0 on dev") not triggered; N=8 still best,
  expectancy/trade 3.828% (419 trades, 157 folds).
- V3: kill not triggered; fill rate 100%, week-1 expectancy 3.427% (vs Control paired +4.061%),
  week-N expectancy 7.171% (vs Control paired +7.805%).
- V4: kill not triggered; week-1 expectancy -0.170% (vs Control paired +0.475%), week-N
  expectancy 4.088% (vs Control paired +4.733%).

**Guardrail calibration (config/experiments.yaml id `G`) was NOT re-run** — checked and
confirmed it was never implemented in the first place (`docs/open-decisions-implementation-plan.md`
still lists "New `scripts/calibrate_guardrails.py`" as a phase-4 to-do; no such script exists in
the repo). Nothing to restate for this one; it's a separate, pre-existing unbuilt item, not
something the RSI fix made stale.

---

## 2026-09-29 (continued) — RSI-band sensitivity study re-run with fixed RSI

`scripts/rsi_param_study.py` re-run (52-week TRAIN 2024-09-30→2025-09-22, 52-week VALIDATE
2025-09-29→2026-09-21 — same windows as the pre-fix run). All 9 candidate bands still had
negative expectancy on TRAIN, same as before the fix. **The band the robustness selection
picks did change**: **[60,75]** now (was [35,50] pre-fix) — a real, non-trivial shift, since
the fixed RSI changes which weeks/trades cross each band's edges, especially for
short-history tickers per the seeding-fix findings above.

**The headline conclusion is unchanged, but the *margin* changed meaningfully**: pre-fix, the
TRAIN-selected band clearly *underperformed* the a-priori [50,65] default on VALIDATE (-1.91%
vs -1.07% expectancy — the RSI-band-tuning story was "don't bother, it's worse"). Post-fix,
the TRAIN-selected band's VALIDATE expectancy (-0.958%, n=38 trades/25 weeks, hit rate 34.2%)
is now statistically indistinguishable from the a-priori default's (-0.950%, n=151/44, hit rate
35.1%) — both negative, a 0.008pp gap. So the fix didn't change *whether* a band rescues the
strategy (no band does, before or after), but it did remove what used to look like a clear
argument against even trying to tune the band — post-fix, tuning is simply neutral, not
actively harmful. `README.md` updated to the new numbers and bottom line.

This closes out every item flagged in the 2026-09-29 RSI-fix work: `src/indicators/rsi.py`
fixed and tested, Control's 104-week walk-forward (both fixed-exit and trend-hold) re-run,
Literal's `replay_horizons()` re-run, the flag matrix's 104-week replay + T4 calibration
re-run, V2/V3/V4 re-run, the RSI-band sweep re-run, the §04 dashboard rebuilt, and the
`rebuild-test-control-dashboard` skill updated additively. Not done (explicitly, separately
flagged, not silently stale): guardrail calibration (never built in the first place) and the
Literal `replay()`/`midweek_scan_replay()` commands (lower priority, still optional follow-up).

---

## 2026-09-29 (continued) — D4 reverted: flat-series RSI now matches TradingView's real 100, not neutral 50

The user pasted TradingView's actual Pine Script v6 RSI source and asked for a line-by-line
comparison against `src/indicators/rsi.py:compute_rsi()`. Two outcomes:

1. **Confirmed the seeding fix above was complete and correct** — Pine's `ta.rma()` seeds with
   the SMA of the first `length` values then recurses, exactly matching
   `_wilder_smooth_sma_seeded()`.
2. **Surfaced a second, smaller divergence**: Pine's real formula is
   `down == 0 ? 100 : up == 0 ? 0 : 100 - (100/(1+up/down))` — `down == 0` returns 100
   *unconditionally*, even when `up` is also 0 (a truly flat, zero-movement series). Our code
   had the "D4" override (26 Sep 2026, Dharmin's decision): flat → neutral 50 instead. A
   deliberate, considered design choice at the time, not a bug — but a confirmed divergence
   from TradingView's actual behavior.

**Blast radius checked before deciding** (an Explore agent): the flat condition (14+
consecutive weeks of literally zero close-to-close change) fires on **0 tickers** in
`data_cache/weekly_ohlcv_260w.parquet` (Control's real 502-ticker screened universe). It fires
on 19 tickers / 828 rows in Literal's much larger full-NSE cache — but all 19 are
suspended/illiquid penny stocks present only in the raw full-equity-list, none in the
midcap150/smallcap250/nifty500 index constituents, and all would fail the liquidity
(median turnover ≥ ₹10cr) and market-cap band filters regardless of their RSI. **D4 has never
changed a single screening outcome on any cached data.**

**Decision, per the user: revert D4, match TradingView exactly.** Given the confirmed
zero-impact blast radius, this did **not** need Part 4's re-run cascade — no backtest, replay,
or dashboard number has ever depended on the flat case firing on a real candidate.

**Changed**: `src/indicators/rsi.py` — removed the `flat = ... ; rsi = rsi.mask(flat, 50.0)`
override; the line above it (`rsi.where(avg_loss != 0, 100.0)`) already produces TradingView's
correct value once the override is gone. `tests/test_indicators.py` and
`tests/test_indicators_properties.py` — both flat-series tests renamed and updated to assert
100 instead of 50 (`test_rsi_flat_series_matches_tradingview_100` in both files now).

**Full suite regression check surfaced three pre-existing issues, unrelated to this change**,
now fixed or flagged separately rather than silently left broken:
- `tests/test_wow.py`'s two regression-guard tests (`test_control_arm_reproduces_241_trade_rows`,
  `test_zero_pick_weeks_are_null_not_zero`) had hardcoded counts (241 trades, 104 weeks) pinned
  to a `results/feature_flags/replay/` snapshot from *before* this session's earlier flag-matrix
  replay re-run (Part 4, RSI seeding fix). That replay legitimately produced new numbers (244
  trades, 107 weeks — the week count grew because this session's replay window
  (2024-09-09→2026-09-21) is wider than whatever produced the original 104-week snapshot, not
  because of the RSI fix itself). Updated both tests to the new, correct baseline
  (`test_control_arm_reproduces_244_trade_rows`, with dated comments); fixed
  `test_regression_guard_all_three_estimators`'s numbers too (pooled_net -1.522→-1.532,
  pooled_excess -0.634→-0.636, weekly count 74→75, weekly mean -1.679→-1.703).
- `tests/test_flags_audit_detects.py::test_au04_tampered_csv_fails` fails whenever the repo has
  any real uncommitted files under `results/forward_test/`/`results/feature_flags/` — it calls
  the real `_au04()` audit check, which shells out to live `git status`, and never mocks that.
  Unrelated to RSI/D4; flagged as a separate follow-up task rather than patched here.
- `tests/test_screen_funnel.py::test_sector_rs_is_soft_and_never_eliminates` and
  `tests/test_literal_spec_wiring.py::test_no_risk_cap_means_trade_count_equals_survivor_count`
  both use a relative `all_dates(panels)[OFFSET]` (OFFSET=-3) against the live, refreshable
  `data_cache/weekly_ohlcv_260w.parquet` — re-fetching that cache (as `scripts/run_backtest.py`
  does every run) can shift which real calendar week OFFSET=-3 lands on. Today it landed on a
  week with 0 VStop flips, crashing both tests on an empty survivors frame. Unrelated to RSI/D4;
  flagged as a separate follow-up task (pin to a frozen fixture, or make the offset search
  robust) rather than patched here.

Full suite after all fixes, confirmed: **304 passed, 3 skipped, 3 failed** — the 3 failures are
exactly the three flagged-and-deferred items above (`test_au04_tampered_csv_fails`,
`test_sector_rs_is_soft_and_never_eliminates`,
`test_no_risk_cap_means_trade_count_equals_survivor_count`), each spun off as its own follow-up
task rather than patched here, since neither is caused by or related to the RSI/D4 changes.

---

## 2026-10-02 — graded `fwd_2026-09-21` (signal week 2026-09-21..09-25); threshold experiment graded alongside

Ran the routine weekly grade step (no new record was due — the next Control record is for
signal week 2026-09-28..10-02, due at Monday 2026-10-05's open, not yet reached).
`picks_2026-09-21.json` had 2 survivors (HBLENGINE.NS, WHIRLPOOL.NS), both
`SHADOW_rejected_by_risk_cap` — **0 actual Control trades this week**, so the "traded basket"
net is `None`, not zero. Both shadow survivors lost: HBLENGINE -3.315% net, WHIRLPOOL -4.083%
net (shadow basket net -3.699%). The two RSI-band near-misses (PATANJALI, CARBORUNIV) also both
lost, averaging -5.321% net — the RSI filter didn't save anything this week, but n=1 week tells
us nothing about whether that's signal or noise.

Threshold experiment graded alongside (`threshold_2026-09-21`, mode `late_backfill`, X4/X5/X6 all
PASS): every risk-cap arm from 17.5% up through 50% selected both names and matched the shadow
basket's -3.699%; only the 15% arm rejected both (matching Control's own 15% cap, net 0.0% i.e.
no trades). Diagnostic pack (`tests.track_forward summary`) now has 3 graded weeks total — still
far short of the 13-week first-look threshold, so no series (Control, shadow, near-miss, T1, T2,
T3) is statistically readable yet. One week is not evidence; logging and moving on per the
harness guardrail.
