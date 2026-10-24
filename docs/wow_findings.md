# Week-over-week arm history — findings log

Dated notes on runs of `python -m tests.track_wow {build,summarise,diagnostics}`
(spec: `docs/wow-arm-history-analysis-plan.md`). Appended after each run, not edited
retroactively. Read this alongside `results/wow/arm_summary.csv` and
`results/wow/trend_tests.csv` — this log interprets, it doesn't restate every number.

**What this study cannot conclude (§5.5, repeated here per the plan's own instruction):**
104 weeks with a median of ~2 Control picks per week is a small sample carrying heavy
market-factor correlation. It can distinguish "consistently negative" from "was positive,
now negative". It **cannot** establish a positive edge for any arm, and it **cannot** be
the basis for graduating one. Nothing below should be read as a graduation signal for any
Test arm — T4 in particular is already killed by its own pre-registered DEV/VALIDATE
protocol (2026-09-15 finding); nothing here reopens that.

---

## 2026-09-19 — first build, Lane A + Lane B + Lane C, Q1/Q2 first read

Manifest: `results/wow/manifest.json`. Lane A: 104 weeks, 27,420 eligible-universe rows,
18 registered arms (`universe`, `control`, `riskcap_rejected`, `near_miss_rsi`, `flip_all`,
`t4_k7..t4_k11`, `threshold-experiment_{15,17.5,20,22.5,25,30,40,50}`). Lane B: V2/V3/V4,
120 dev weeks each, isolated (T-05 asserted). Lane C: 2 rows total (`control_live` 1 week,
`t1_shadow` 1 week) — contributes no history yet, exists only so the append path is proven
(T-09) before there's anything to append.

### Regression guard (T-02) — restates, does not revise, the known baseline

Pooled Control `net_pct` = **-1.522%** (n=241), pooled `excess_eligible_pp` = **-0.634pp**,
week-equal-weight (headline) = **-1.679% / -0.918pp** over 74 weeks-with-picks. All four
reproduced exactly from `arm_week_panel.csv`. Framing stands: this is a study of a signal
whose pooled expectancy is already known negative.

### Q1 — is there a trend? Disagreement, not a clean answer (§4.2 item 3, reported not resolved)

Control `net_pct`, OLS-on-week-index with Newey-West(4) SE: **slope +0.036%/wk, p=0.007**
— a nominally significant *improving* (less negative) trend over the 104 weeks. The
non-parametric cross-check does **not** confirm it: Mann-Kendall **tau=+0.124, p=0.119**.
First-half vs second-half (block-bootstrap CI, block=4): mean -2.377% (weeks 1-37) to
-1.254% (weeks 38-74), diff +0.993pp, **CI95 [-1.074, +2.988] — includes zero**.

Two of the plan's three trend tests do not confirm a trend; only the parametric OLS does,
and only at a p-value that would not survive Bonferroni correction across the 18-arm
family this study tests (0.05/18 ≈ 0.0028). **Read this as "no confirmed trend, weak signal
of the OLS agreeing with itself across bases"** (`excess_eligible_pp` p=0.243,
`excess_bench_pp` p=0.148 — neither reaches even the unadjusted 0.05) rather than as
evidence of decay or improvement. `flip_all` (the untradeable ceiling arm) shows the same
pattern at a similarly marginal level (OLS p=0.040, MK p=0.105) — consistent with the
improving-OLS-only pattern being a property of the shared market-factor window, not
something specific to Control's filters.

### Q1's third outcome — regime-conditional, and it's the biggest number in this whole run

Control split by `market_regime_bench_above_sma30w` (§4.3, descriptive only — below the
26-week trend floor on either side, so no trend test is run on the split, per this study's
own suppression rule):

| Split | weeks-with-picks | mean net_pct |
|---|---|---|
| regime_on | 60 | **-2.113%** |
| regime_off | 14 | **+0.185%** |

A 2.3pp swing between regime states, on a pooled headline of -1.68%. This is the sharpest
single fact in this run and matches Q1's third possible outcome from the plan's own framing
(§1, "Regime-conditional — the series flips sign with the benchmark regime flag"). It is
also the thinnest evidence in this run — 14 weeks is barely half the 26-week trend floor —
so it is reported as a lead worth re-checking as more weeks accumulate, not as a settled
regime-conditional edge. `npicks` buckets show a smaller, monotonic pattern (1 pick:
-2.42%, 2-3: -1.35%, 4+: -1.29%) — more names selected in a week correlates with a less
negative week, worth another look once there's more data, not acted on here.

### Q2 — which arm dominates paired vs control? Not any registered Test arm.

Paired weekly diff vs `control` (block-bootstrap CI, `net_pct` basis — recall the paired
difference is *identical* across `net_pct`/`excess_eligible_pp`/`excess_bench_pp` by
construction: both arms share the same week's eligible-mean and benchmark, so those
additive terms cancel in a same-week difference):

| Arm | n paired weeks | mean diff (pp) | CI95 |
|---|---|---|---|
| **universe** (untradeable, whole eligible set) | 74 | **+0.918** | **[+0.266, +1.773]** |
| t4_k9 | 74 | +0.709 | [+0.032, +1.597] |
| t4_k8 | 74 | +0.691 | [+0.041, +1.569] |
| t4_k7 | 74 | +0.672 | [+0.016, +1.566] |
| threshold-experiment_20 | 74 | +0.328 | [-0.083, +0.770] |
| flip_all | 74 | +0.114 | [-0.297, +0.572] |
| riskcap_rejected | 59 | +0.080 | [-1.025, +0.991] |
| near_miss_rsi | 36 | -0.781 | [-1.880, +0.349] |

Stated plainly, per §1.1's instruction not to bury this: **the arm with the largest,
CI-excludes-zero paired edge over Control is `universe` — buying the whole eligible
universe equally every week, which is not tradeable as a strategy and carries no risk
cap, no stop, no sizing rule.** That is not a discovery about a better selection rule; it
is a restatement of the same fact the regression guard already carries — Control's
filters (VStop flip + RSI band + risk cap) underperform a coin flip drawn from their own
eligible universe by close to a point a week. `t4_k7/8/9` show smaller, similarly
CI-excludes-zero deltas (+0.67 to +0.71pp) over this pooled 104-week window — but T4 is
already killed by its own pre-registered DEV/VALIDATE protocol (2026-09-15 finding, kill
criterion (a): VALIDATE-half mean ≤ 0), which used a disciplined non-overlapping split.
This pooled-full-window read is a *different, less disciplined* comparison (no dev/validate
split, 18 simultaneous comparisons, no Bonferroni correction applied to the CI itself) and
must not be read as reopening or contradicting that kill decision. `threshold-experiment_15`
(= Control by construction) is exactly zero, as required (T-03/X6-style check, now
reproduced at the panel level too).

**Multiple-comparison caveat, stated per §5.2:** 17 arms were paired against Control in
this pass (every registered Lane A arm except Control itself). At an (unadjusted) 95% CI,
roughly 1 in 20 comparisons is expected to exclude zero by chance alone even under a true
null. Four of seventeen excluding zero (`universe`, `t4_k7`, `t4_k8`, `t4_k9`) is more than
chance alone would predict, but not overwhelmingly so, and none of the CI lower bounds
clear a Bonferroni-adjusted threshold. No arm graduates on this evidence (§5.2's own rule);
this paragraph exists so a reader doesn't quietly promote one of these numbers later.

### Diagnostics (§4.4) — the question that started this plan

- Top-10-by-`flags_met` week-over-week overlap: **mean 30.7%** across 103 week-pairs
  (min(prev,cur)-normalized Jaccard-style overlap, ties broken by ticker). Lower than the
  40% figure quoted in this plan's own §1.1 write-up — that number came from an earlier,
  less formal look; this run's methodology (documented in `src/wow/diagnostics.py`) is the
  one to trust going forward, and the two aren't computed the same way (this is a stricter,
  reproducible definition).
- `flags_met` lag-1 autocorrelation, pooled across ticker-weeks: **0.773** (n=27,074) — high,
  confirming the plan's framing that the candidate layer is dominated by state, not events.
- Per-flag week-over-week persistence: **7 of 13** countable flags clear 70% persistence
  (full table in `results/wow/repetition_diagnostics.csv`, `metric_type=flag_persistence_rate`)
  — fewer than the plan's rough "12 of 13, 73-95%" claim. Worth a follow-up pass to see
  which 6 flags are actually event-like (closer to A01's ~2.6% pass-rate character) versus
  which are state that simply persists less than 70% (e.g. near a threshold boundary,
  flapping). Not investigated further in this pass.

### T1 vs. Control (Lane C) — mechanism wired, not a read

T1 has no flag-matrix-replay equivalent (it scans daily bars the weekly replay panel
doesn't carry), so it can't be reconstructed in Lane A the way `t4_k*` or the threshold
arms can — it only lives in Lane C. `paired_vs_control()` is now also called for Lane C
(`control_live` vs `t1_shadow`, `tests/track_wow.py`), writing rows into the same
`paired_vs_control.csv` with the same 13-paired-week floor and suppression rule as Lane A.
Today: **1 graded Lane C week** (2026-09-07) — `status="insufficient history (n=1,
floor=13)"`. On that single week, Control's 2 picks made +4.35% vs. T1's 14-name basket at
-0.04% (a -4.40pp gap) — not reported as a comparison, exactly per §5.4: one week doesn't
clear the floor no matter how large the gap looks. The mechanism will read as a real
block-bootstrap CI once 13 Lane C weeks are graded, with no further code change (added to
`docs/dashboards/wow-trend-dashboard.html`'s new §03b for visibility as it accumulates).

### What wasn't done in this pass (2026-09-19 run)

Per-split trend tests and per-split paired-vs-control (documented simplification in
`src/wow/summarise.py` — see its module docstring): only the unsplit series gets the full
OLS/MK/half-split/paired treatment; splits get descriptive means only. Lane B has no trend
tests run yet (arm_summary computed, `trend_tests.csv` includes Lane B rows but they were
not specifically interpreted here — see the raw table). Lane C is real but empty of
history by construction; nothing to say about it until more forward weeks are graded.

---

## 2026-09-20 — T1 historical replay: build-in-progress notes, and a cache-corruption defect found and fixed

Building T1's own multi-week replay (`src/screen/t1_scan.py:scan_t1_week()`,
`tests/track_forward.py:t1_replay()`), so `t1_shadow`/`t1_shadow_filtered` can carry the
same kind of 104-week history Control's flag-matrix replay already has, instead of a
single live-forward dot. Two real bugs surfaced and were fixed before trusting any output:

1. **Future-bar leakage in the original window logic.** `record_t1_shadow()`'s
   `days = all_dates(daily_panels)[-5:]` took the daily cache's globally-last 5 dates,
   unconditional on `as_of` — correct only when `as_of` happens to be "today" (the live
   path), wrong for any historical week a replay would ask for.
2. **A subtler date-alignment bug in the first fix attempt.** Weekly signal dates are
   Monday-dated (e.g. `"2024-09-09"`), but the first fix filtered daily bars as `d <= as_of`
   — which excludes that week's own Tuesday-Friday bars entirely, since they're dated
   *after* the Monday. Fixed by bounding the window to `[as_of, as_of + 6 days]` (that
   week's own Monday-Sunday span) instead. Caught by the T-13/T-15 regression tests failing
   against real weekly/daily data, not by inspection.

**Separately, a cache-corruption defect was found and fixed mid-session:**
`src/wow/three_line.py:fetch_nifty50_into_cache()` (added last session) called
`adapter.benchmark_series("^NSEI", ...)` — a single-ticker request. `OpenSourceAdapter.
weekly_ohlcv()` (`src/data/adapter.py`) treats its 12h cache as all-or-nothing: when stale,
a single-ticker request **overwrites the entire multi-ticker `weekly_ohlcv_260w.parquet`
with just that one ticker**, silently corrupting the shared cache `record()`/`grade()`/
`t1_replay()` all depend on. This actually happened in this session (the cache was found
collapsed from 500 tickers to 1) and broke a running replay attempt ("no weeks in range").
Fixed by having `fetch_nifty50_into_cache()` always request the full universe + `^NSEI`
together, matching `scripts/common.py:bootstrap()`'s pattern; the cache was restored via a
fresh `bootstrap()` call. Anyone running `tests.track_wow build` after a >12h gap should be
aware this class of bug can recur elsewhere if a future caller ever requests a data_cache
weekly refresh for fewer than the full universe.

**Runtime**: profiled at ~90s of compute per replay week (`compute_vstop`'s row-by-row
`.iloc` recurrence dominates, called ~1,500 times/week across daily+weekly scans) — a
pre-existing cost in the indicator, not introduced here. Full 104-week backfill is
therefore a ~2.5 hour one-time run, executed as a standalone background process
(`python -m tests.track_forward t1replay 2024-09-09 2026-08-31`), matching the plan's own
"run once on your Mac" framing for `scripts/backfill_history.py`.

### T1 replay — the read, once the backfill finished (104 scanned, 102 graded)

Two weeks of the 104 didn't grade (no forward bar available for those signal weeks in the
cache — not investigated further, 2/104 is immaterial to any read below). Numbers below are
from `results/wow/arm_week_panel.csv` (`lane=C, recording_mode=replay`) and
`results/wow/t1_replay_vs_control_replay.csv`.

**Level.** `t1_shadow`: 102 weeks with picks, mean basket net **-0.556%/wk**, win-week rate
**39.2%**. `t1_shadow_filtered` (score≥40 sub-basket): 99 weeks, mean **-0.934%/wk**, win
rate **29.3%** — worse than unfiltered, same direction as every single-week read of this
filter so far (§04b/§04c of the other dashboard). Both still negative, both still better
than Control's own -1.679%/wk pooled-week mean over the same kind of window — T1 is "less
bad", not "good".

**Q1 — trend.** Neither series shows a confirmed trend: `t1_shadow` OLS slope +0.0095/wk
(p=0.328), Mann-Kendall tau +0.032 (p=0.631); `t1_shadow_filtered` OLS +0.0106/wk (p=0.221),
MK tau +0.063 (p=0.355). Both non-significant on both tests — no decay, no improvement,
consistent with Control's own OLS/MK disagreement read (§Q1 above) resolving to "no
confirmed trend" once both tests are required to agree.

**Q2 — paired vs. Control's own replay, same 104-week grid.** This is the number worth
sitting with: `t1_shadow` **+0.948pp/wk, CI95 [+0.290, +1.789]**, n=73 paired weeks;
`t1_shadow_filtered` **+0.923pp/wk, CI95 [+0.239, +1.765]**, n=72. Both CIs exclude zero.
Reading this against the earlier Lane A ranking (§Q2 above): T1's replay edge over Control
sits in the same range as `t4_k10` (+1.094pp) and above `universe`/`t4_k7-9` (+0.67 to
+0.92pp) — the largest positive deltas found anywhere in this study so far.

**Read this carefully, not eagerly.** This is exactly the kind of number the plan's own
§1.1 framing warns against overreading: (1) it is a **dev-backtest**, commensurable with
Control's exit convention but not forward evidence — T1's own graduation gate
(`docs/forward-test-response-and-volume-plan.md` §3.5/§4) requires a forward bootstrap CI
beating Control, and T1 is at n=1 forward week, nowhere near that; (2) this adds an 18th
and 19th comparison to the same multiple-comparison family discussed in §Q2 above (17 Lane A
arms paired against Control) — with more comparisons the Bonferroni-adjusted bar for
"real" gets stricter, not looser, and neither of these new CIs would clear a correction for
~19 simultaneous tests; (3) T1's own selection mechanism (catching mid-week flips) is a
structurally different kind of edge than the flag-count/threshold arms already in Lane A,
so a positive dev-backtest read here doesn't validate or invalidate those — it's a
separate, single new data point in the same "things that beat Control's own replay in this
window" bucket that already includes an untradeable baseline (`universe`) at the top. No
arm graduates on this evidence; T1's forward review point stays exactly where it was.
