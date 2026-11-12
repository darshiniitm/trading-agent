# Week-over-week arm history — analysis plan

*Version 0.1 — 2026-09-19. Implementation spec for Claude Code. Scope: reconstruct,
for every registered arm, the weekly pick list and its end-of-week return across all
available history, on a common week grid, and test whether performance **trends** —
improving, decaying, or flat noise. Read-only over existing graded records. Defines no
new strategy, changes no condition in `config/rules.yaml`, and touches neither Control's
picks nor its capital.*

Companion to `docs/feature-flag-matrix-plan.md` (the flag matrix and T4),
`docs/forward-test-response-and-volume-plan.md` (T1–T3), `docs/threshold-experiment-plan.md`
(risk-cap sweep) and `config/experiments.yaml` (V-series). This plan consumes their
outputs; it does not modify any of them.

---

## 1. The question

Two questions, in strict order. The second is only worth asking if the first has an
answer other than "no".

**Q1 — Is there a trend?** For each arm, does the weekly net return series have a
detectable slope over the 104 replay weeks, or is it a flat draw from one distribution?
Three outcomes are materially different for the project:

- *Decay* — the edge existed early and has eroded (crowding, regime change, or the
  parameters were fit to a period that ended).
- *Never there* — the series is flat and negative throughout; no amount of re-timing
  helps, and the arm's mechanism is the thing to revisit.
- *Regime-conditional* — the series flips sign with the benchmark regime flag, in which
  case the arm isn't broken, its deployment condition is missing.

**Q2 — Which arm's week-over-week series dominates, and by how much on paired weeks?**
Only arms already registered before this plan qualify (§5.1).

### 1.1 What the data already says, stated up front

This is not a neutral fishing expedition, and the spec should not pretend otherwise.
On the 104-week graded replay (`results/feature_flags/replay/flags_*_graded.csv`):

| Population | n | Mean 1-wk net | Hit rate |
|---|---|---|---|
| Control `TRADE` | 241 | **-1.52%** | 36.5% |
| Eligible universe (all rows) | 28,351 | -0.41% | — |
| Control `excess_eligible_pp` (pooled) | 241 | **-0.63 pp** | — |
| Control, equal-weight per week (74 wks) | 74 wks | **-1.68%** / **-0.92 pp** excess | — |

Control has selected, over two years, a basket that underperforms a coin flip drawn from
its own eligible universe by roughly 1.1 pp per week. The `-1.10%/wk` figure recorded against the V7a diagnostic in `config/experiments.yaml` is
a *third* estimator — the difference of the two pooled means (-1.522 - -0.413 = -1.109) —
not the recorded excess column. Three numbers, one name: hence the ladder in §1.2. So the honest
framing of this workstream is: **a week-over-week study of a signal whose pooled
expectancy is already known to be negative**, run to find out whether it was ever
positive and when that stopped — not to find a winner among the arms. An implementation
that buries this in the output is a failed implementation.

Related structural finding (2026-09-19, this session): Control's final picks do **not**
repeat week to week — 0 of 183 consecutive-week repeats, 161 distinct tickers across 241
picks — because `A01_vstop_flip_up` is an event with a 2.6% pass rate. The repetition is
in the *candidate* layer: the top 10 by `flags_met` has 40% week-over-week overlap,
because 12 of 13 flags are state, not events (persistence 73–95% week over week). The
panel this plan builds is the substrate for quantifying that properly, so `flags_met`
autocorrelation is a required output (§4.4), not an optional extra.

### 1.2 The metrics this study measures

Full definitions in §4; this is the complete inventory, so the metric set can be argued
about before any code is written. Every metric is **read from a recorded column or derived
from recorded columns** — none re-runs the screener and none re-fetches a price.

**Aggregation ladder.** Fixed, and the same for every arm. Ambiguity here is what produced
the estimator error corrected in §1.1:

> pick → **week** (equal weight across that week's picks) → **across weeks** (equal weight,
> one observation per week regardless of pick count).

A 12-pick week and a 1-pick week each count once at the top level. Pooled row-means are
reported too, but as a clearly labelled *secondary* column — never as the headline.

**L0 — per pick (recorded, never recomputed)**

| Metric | Source column | Note |
|---|---|---|
| `net_pct` | `fwd_ret_oc_net_pct` | Next week's open → Control exit, 0.5% round trip |
| `excess_eligible_pp` | `fwd_excess_vs_eligible_pct` | vs that week's eligible-universe mean |
| `excess_bench_pp` | `fwd_excess_vs_benchmark_pct` | vs NIFTYMIDCAP150 |
| `exit_reason`, `exit_price` | as recorded | stop vs week-close |
| `R_pct_of_close` | as recorded | drives the threshold arms |
| `flags_met`, `delta_flags_met` | recorded / derived | `delta` = this week − prior week, same ticker |
| `missing_forward_bar` | as recorded | 0 across the current panel; must stay auditable |

**L1 — per arm, per week (the basket)**

`n_picks` · `basket_net_pct` · `basket_excess_eligible_pp` · `basket_excess_bench_pp` ·
`hit_rate` (share > 0) · `stop_hit_rate` · `median_pick_net` · `dispersion` (stdev across
the week's picks) · `n_missing_forward_bar`.

Plus the **three-line weekly series** (§4.5) — the headline chart of this study:
`basket_net_pct` · `nifty50_wk_pct` · `niftymidcap150_wk_pct`, and the two spreads
`vs_nifty50_pp`, `vs_midcap150_pp`. One row per week, three comparable lines.

Zero-pick weeks: `n_picks = 0` and **null** returns, never 0.0 (§4.1).

**L2 — per arm, across weeks**

| Metric | Purpose |
|---|---|
| Mean + median of each of the three bases | Level. The headline triplet. |
| `n_weeks_with_picks`, `n_cash_weeks` | Printed beside every mean — 30 of 104 weeks are cash for Control |
| `win_week_rate` | Share of weeks with a positive basket |
| Equity curve (compounded, cash weeks at 1.0) | Shape. Diagnostic only, not a P&L claim |
| Max drawdown of that curve | Shape |
| Rolling 13-week and 26-week mean | Local level |
| OLS slope on week index + Newey-West se (lag 4) | **Trend — Q1** |
| Mann-Kendall tau + p | **Trend — Q1**, non-parametric cross-check |
| First-half vs second-half mean + block-bootstrap CI | **Trend — Q1**, assumption-light |
| Paired weekly diff vs `control` + CI + `n_paired_weeks` | **Q2** |
| Pooled row-mean of each basis | Secondary, labelled |

**L3 — repetition diagnostics (§4.4)**

Top-10-by-`flags_met` week-over-week overlap · per-flag persistence rate ·
`flags_met` autocorrelation · distinct tickers in each arm's trailing 13 weeks ·
per-ticker appearance count in each arm's top decile.

**Required splits**, applied to every L2 metric: benchmark regime on/off, and `n_picks`
bucket (1, 2–3, 4+).

---

## 2. Data lanes — and why they cannot be merged

Three lanes with different week grids and different exit conventions. **Merging them into
one series is the single most likely way to get this wrong.** Each renders as its own
panel, with its own week axis, and cross-lane comparison is reported only as a
qualitative note, never as a computed difference.

### Lane A — flag-matrix replay (primary)

- Source: `results/feature_flags/replay/flags_<wk>_graded.csv`, 104 files.
- Grid: **2024-09-09 → 2026-08-31**, 104 contiguous signal weeks, 28,351 rows
  (mean 272.6 eligible names/week, mean 5.5 survivors/week).
- Carries all 13 flags, `control_status`, `R_pct_of_close`, regime flag, **and** the three
  return bases already computed and graded. `missing_forward_bar` is 0 across the panel.
- This is the only lane with enough weeks to answer Q1. It is the backbone.

### Lane B — V-series dev backtests (secondary panel)

- Source: `results/experiments/V{2,3,4}_*_trades.csv` (416 / 415 / 416 trades).
- Grid: dev segment from **2021-07-05**, and — critically — **different exit conventions**
  (V2 holds N weeks; V3 needs a limit fill; V4 enters intra-week). Their `ret_pct_net` is
  not commensurable with Lane A's `fwd_ret_oc_net_pct`.
- Rendered as its own panel with its own week axis. Where Lane B weeks overlap Lane A
  weeks, report the overlap count but **do not** compute a paired difference across lanes.

### Lane C — live forward test (append-only, near-empty today)

- Source: `results/forward_test/picks_<wk>_graded.csv`, `picks_<wk>_t1.json`,
  `results/feature_flags/flag_ledger_grades.csv`, `results/threshold_experiment/`.
- Grid: **1 graded week (2026-09-07)** as of writing. T1 has one graded week
  (`fwd_2026-08-31`, per `forward-test-response-and-volume-plan.md` §3.7); T2/T3 are
  reweightings of Control's own list; the threshold arms derive from Control's picks file.
- Lane C contributes **no history**. Its entire purpose in this plan is that the builder
  is written so each future weekly `grade` run appends one row per arm to the same panel,
  with no schema change and no backfill. Any statistic computed on Lane C alone is
  suppressed below a minimum of 13 graded weeks (§5.4), rendered as "insufficient history"
  rather than as a number.

---

## 3. Arm registry for this study

Every arm is reconstructed **from recorded fields only**. No arm re-runs the screener, and
no arm re-fetches prices. If an arm cannot be rebuilt from the graded panel's own columns,
it is out of scope for Lane A and belongs to Lane C's forward record.

### 3.1 Lane A arms (deterministic row filters on the graded panel)

| Arm id | Definition (row filter within a signal week) | Notes |
|---|---|---|
| `universe` | all rows | Baseline. Equal-weight mean of the eligible universe. |
| `control` | `control_status == 'TRADE'` | The real arm. |
| `riskcap_rejected` | `control_status == 'SHADOW_rejected_by_risk_cap'` | 335 rows. |
| `near_miss_rsi` | `control_status == 'NEAR_MISS_failed_rsi_band'` | 132 rows. |
| `flip_all` | `A01_vstop_flip_up == 1` | Every flip, before any filter. Control's ceiling. |
| `t4_k{K}` | top-K by `flags_met`, ties broken as `tests/track_flags.py` already breaks them | K from the calibrated set in `feature-flag-matrix-plan.md` §7.3. Reuse that code path — do not reimplement the tie-break. |
| `thresh_{cap}` | `A01 & A03 & uptrend & R_pct_of_close <= cap` | cap ∈ {15, 17.5, 20, 22.5, 25, 30, 40, 50} per `config/threshold_experiment.yaml`. `cap_inclusive: true`. cap=15 must reproduce `control` exactly — assert it (§6, T-03). |
| `regime_on` / `regime_off` | `control` split by `market_regime_bench_above_sma30w` | Not a separate arm; a required split of `control` (§4.3). |

### 3.2 Lane B arms

`V2_N2`, `V2_N4`, `V2_N8`, `V3_week1`, `V3_weekN`, `V4_week1`, `V4_weekN` — read as-is
from their trade files, keyed on `signal_week` / `week_start`. Report `ret_pct_net` only,
labelled with each arm's exit convention in the column header.

### 3.3 Lane C arms

`control_live`, `t1_shadow` (split by window offset and by days-since-flip per
`forward-test-response-and-volume-plan.md` §3.7 items 2–3), `t2_fixed_fractional`,
`t3_confidence_weighted`, `t4_live`, `thresh_live_{cap}`. All suppressed until 13 weeks.

---

## 4. Metrics

### 4.1 Per arm, per week (the panel row)

Three return bases side by side, all three already present as graded columns — recompute
none of them:

- `net_pct` — from `fwd_ret_oc_net_pct`. Entry at the next week's open, Control's exit
  convention, 0.5% round-trip costs.
- `excess_eligible_pp` — from `fwd_excess_vs_eligible_pct`. **The headline for signal
  quality**: it separates "the signal is bad" from "the market was bad".
- `excess_bench_pp` — from `fwd_excess_vs_benchmark_pct` (NIFTYMIDCAP150).

Basket aggregation is **equal-weight within the week** (Control's own sizing). Per week
also record: `n_picks`, `hit_rate` (share > 0), `stop_hit_rate` (`exit_reason` == stop),
`dispersion` (stdev of member net returns), `median_pick_net`, and `n_missing_forward_bar`.

An arm with zero picks in a week yields a row with `n_picks = 0` and **null** returns —
never 0.0. Control has no `TRADE` in 30 of 104 weeks; treating those as flat zeros would
silently improve every drawdown and volatility statistic in this study.

### 4.2 Per arm, across weeks (the trend layer)

1. **Equity curve** — compound the weekly equal-weight basket net return, weeks with no
   picks compounding at 1.0 (cash), with the cash-week count printed beside the curve.
2. **Rolling 13-week and 26-week mean** of each of the three bases.
3. **Trend test** — OLS slope of the weekly series on week index with Newey-West standard
   errors (lag 4), *and* a non-parametric Mann-Kendall test. Report both; disagreement
   between them is itself reportable and must not be silently resolved.
4. **First-half vs second-half** split of the 104 weeks: mean of each basis, with a
   block-bootstrap CI on the difference (§5.3). This is the blunt instrument that answers
   "did it decay" without depending on a functional form.
5. **Paired weekly difference vs `control`** on weeks where both arms have ≥1 pick: mean
   paired difference, bootstrap CI, and the count of paired weeks (which will be well
   under 104 for most arms and must be printed next to every such figure).

### 4.3 Required splits

Every arm's summary repeats under: benchmark regime on/off
(`market_regime_bench_above_sma30w`), and `n_picks` bucket (1, 2–3, 4+). The regime split
is required because a regime-conditional edge and a dead edge look identical in the pooled
series, and distinguishing them is Q1's third outcome.

### 4.5 The three-line weekly series — picks vs NIFTY 50 vs NIFTY MIDCAP 150

The primary output of this study, and the one chart to get right: for **every week on the
grid**, three comparable returns on one axis.

| Series | Definition | Source |
|---|---|---|
| `basket_net_pct` | Arm's equal-weight basket, holding-week **open → close**, net of 0.5% round trip | `fwd_ret_oc_net_pct`, already graded |
| `niftymidcap150_wk_pct` | NIFTY MIDCAP 150, same holding week, **open → close**, gross | `NIFTYMIDCAP150.NS`, already in the pipeline |
| `nifty50_wk_pct` | NIFTY 50, same holding week, **open → close**, gross | `^NSEI` — **new dependency**, see below |

Derived per week: `vs_midcap150_pp = basket_net_pct - niftymidcap150_wk_pct` and
`vs_nifty50_pp = basket_net_pct - nifty50_wk_pct`.

**Convention matching is the whole game here.** The picks are entered at the holding
week's open and exited at its close. An index return quoted close-to-close covers a
different window and would silently import the weekend gap into the comparison. Both index
series are therefore computed **open → close on the same holding week** as the basket,
from the same weekly bars. A test asserts the index week and the basket week are the same
bar (T-10).

**Cost asymmetry, stated not hidden.** The basket carries 0.5% round-trip costs; the
indices carry none and are not investable as quoted. The comparison is therefore
conservative against our picks by roughly 0.5 pp/week, which is the honest direction for
it to lean. Report the gross basket figure as a secondary column so the size of that
wedge is visible rather than argued about.

**Why NIFTY 50 as well as the midcap index.** They answer different questions.
NIFTY MIDCAP 150 is the fair benchmark — same cap segment as the eligible universe, so a
spread against it is close to a real selection effect. NIFTY 50 is the *opportunity-cost*
line: it answers "would doing nothing but holding large caps have beaten this", which is
the question a reader of the equity curve will ask anyway. Neither is the eligible-universe
mean from §4.1, which stays in the panel — that one isolates selection skill within the
funnel, while these two place the whole strategy against what was freely available.

**Gaps and holidays.** NSE weeks with a truncated session are kept, not dropped, and both
index series must be non-null on every week where any arm has a pick. A week where an
index bar is missing is recorded with a null index value and an explicit
`index_missing` flag, never carried forward from the prior week.

**Rendering.** Three lines, weekly, over the 104-week Lane A grid, plus the same three
compounded as cumulative curves, plus a bar of the weekly spread `vs_midcap150_pp` (the
fair-benchmark spread) with its zero line. Rolling 13-week means of all three overlay the
weekly series, which is otherwise too noisy to read at n≈3 picks/week.

### 4.4 Repetition diagnostics (the question that started this)

On the same panel, per week: top-10-by-`flags_met` overlap with the prior week; per-flag
week-over-week persistence rate; distinct-ticker count in each arm's trailing 13 weeks;
and, per ticker, the count of appearances in each arm's top decile. Emit `delta_flags_met`
(this week minus last week for the same ticker) as a panel column — it is the candidate
for a timing signal that `flags_met` itself cannot be, and having it in the panel is what
makes it testable later without another data build.

---

## 5. Statistical discipline

### 5.1 Pre-registration

Arms are restricted to those **already registered** before this plan: `config/rules.yaml`
(Control), `config/feature_flags.yaml` (registry_version 1, frozen 2026-09-15),
`config/threshold_experiment.yaml` (checksum-locked), `config/experiments.yaml`
(registered 2026-09-16, budget 7). A filter invented while looking at this panel is a
**new experiment** and goes through the existing registry first — it does not get added to
this study's arm list. The builder refuses to emit results for an arm id not in a
registry, matching the discipline `config/experiments.yaml` already enforces.

### 5.2 This study spends no variant budget

It grades no new rule and graduates nothing, so it does not consume slots from the
7-variant budget. Its comparisons are nonetheless multiple: report Bonferroni-adjusted
thresholds across the arms tested in each family, and state the family size next to every
p-value. No arm graduates on evidence from this document.

### 5.3 Resampling

Weekly baskets share market factors, so member-level resampling overstates precision. Use
**week-level block bootstrap** (moving block, block length 4, 10,000 replicates, seed
recorded in the manifest). Every interval printed is a block-bootstrap interval; label it
as such.

### 5.4 Sample-size floors

- No trend statistic on fewer than **26** weeks with ≥1 pick.
- No paired comparison on fewer than **13** paired weeks.
- Lane C arms suppressed entirely under 13 graded weeks.

Below a floor the output prints `insufficient history (n=<x>, floor=<y>)`. It does not
print the number in grey, in a footnote, or "for reference" — those get quoted back later
as if they meant something.

### 5.5 What this study cannot conclude

State it in the output header: 104 weeks with a median of ~2 Control picks per week is a
small sample carrying heavy market-factor correlation. It can distinguish "consistently
negative" from "was positive, now negative". It cannot establish a positive edge for any
arm, and it cannot be the basis for graduating one.

---

## 6. Implementation

### 6.1 Module and CLI

New module `tests/track_wow.py`, following the existing `tests/track_flags.py` and
`tests/track_forward.py` conventions (same argparse shape, same manifest/immutability
discipline, same `run_log.jsonl` append):

```
python -m tests.track_wow build       # build the panel from graded records
python -m tests.track_wow summarise   # arm summaries + trend tests
python -m tests.track_wow diagnostics # §4.4 repetition metrics
python -m tests.track_wow verify      # re-run build, assert byte-identical
```

Shared arm-filter logic lives in `src/flags/` next to the existing flag evaluation, so the
T4 and threshold arm definitions are imported from the code that already owns them rather
than restated.

### 6.2 Outputs

```
results/wow/arm_week_panel.csv        # one row per (lane, arm, signal_week)
results/wow/arm_summary.csv           # one row per (lane, arm, split)
results/wow/trend_tests.csv           # slope, NW se, MK tau, half-split, CIs
results/wow/weekly_three_line.csv    # per week: basket, NIFTY50, MIDCAP150, spreads
results/wow/repetition_diagnostics.csv
results/wow/manifest.json             # source file hashes, seed, registry checksums, UTC
docs/wow_findings.md                  # appended per run, never edited retroactively
```

`arm_week_panel.csv` is the contract. Everything else derives from it, so a reviewer can
recompute any published number from that one file.

### 6.3 Invariants

- **Read-only over results.** Never writes to `results/feature_flags/`,
  `results/forward_test/` or `results/experiments/`. No re-grading.
- **One fetch exception, scoped.** NIFTY 50 (`^NSEI`) weekly bars are not in the pipeline
  today and must be fetched once into `data_cache/` via the existing
  `adapter.benchmark_series` path — the only write this study makes outside
  `results/wow/`. It is a **reporting series only**: it may not enter any gate, score,
  flag, or arm definition. Wiring it into selection would be an unregistered rule change
  (§5.1). Verify `^NSEI` is reachable via yfinance before building, the way
  `NIFTYMIDCAP150.NS` was (`config/rules.yaml` line 43); if it is not, fall back to
  `NIFTY50.NS` or the NSE archive, and record which source was used in the manifest.
- **Deterministic.** Two builds over unchanged inputs are byte-identical (seeded
  bootstrap, sorted output, no wall-clock in the data rows — timestamps live in the
  manifest only).
- **No leakage.** Only `signal_week` fields and that week's graded forward return enter a
  row. Nothing from week *t+1* may touch an arm's *selection* at week *t*. The existing
  leakage tests (`tests/test_flags_leakage.py`, `tests/test_leakage.py`) are the model.
- **Lane isolation.** Lane A and Lane B rows may not appear in the same computed
  difference. Enforced in code, not by convention.

### 6.4 Tests

| id | Assertion |
|---|---|
| T-01 | `control` arm reproduces exactly the 241 `TRADE` rows across the 104 weeks. |
| T-02 | Regression guard, all three estimators: pooled `net_pct` for `control` = -1.522 ± 0.001; pooled `excess_eligible_pp` = -0.634 ± 0.001; week-equal-weight (headline) = -1.679 ± 0.001 net and -0.918 ± 0.001 excess over 74 weeks. |
| T-03 | `thresh_15` is row-identical to `control` (cap-inclusivity boundary). |
| T-04 | Zero-pick weeks are null, not 0.0, and are excluded from means but counted in the equity curve as cash. |
| T-05 | Any cross-lane difference computation raises. |
| T-06 | An arm id absent from every registry raises. |
| T-07 | `verify` produces a byte-identical panel. |
| T-08 | Below-floor statistics emit the suppression string, not a number. |
| T-09 | Adding one new graded forward week appends exactly one row per Lane C arm; no existing row changes. |
| T-10 | For every week, the index bar used for `nifty50_wk_pct` / `niftymidcap150_wk_pct` is the same holding-week bar as the basket's, open→close — not close-to-close, not the signal week. |
| T-11 | `vs_midcap150_pp` reconstructed from the three-line file agrees with the graded `fwd_excess_vs_benchmark_pct` for `control` to within 0.01 pp (cross-check against the pipeline that already computes it). |
| T-12 | `^NSEI` never appears in any arm filter, gate or score — grep-level assertion over `src/flags/` and the arm registry. |

---

## 7. Sequence

1. Panel builder for Lane A + tests T-01/T-03/T-04/T-07 (this is most of the work; the
   panel is the deliverable everything else reads).
2. `summarise` — per-arm metrics, splits, block bootstrap.
3. **Three-line weekly series (§4.5)** — NIFTY 50 fetch, convention-matched index returns, T-10/T-11/T-12. This is the deliverable Dharmin asked for; it lands before the trend tests.
4. `trend_tests` — OLS/NW, Mann-Kendall, half-split.
5. Lane B panel, isolated, with T-05.
6. Lane C append path, suppressed output, with T-09.
7. `diagnostics` (§4.4).
8. First `docs/wow_findings.md` entry.

Steps 1–4 answer Q1 and are worth doing alone. Steps 5–7 exist so this stops being a
one-off analysis and becomes a series that grows by one row per arm per week.

---

## 8. Open decisions for Dharmin

- **D1** — Equal-weight basket confirmed as the only aggregation for Lane A? (T2's
  fixed-fractional sizing is a Lane C arm and would otherwise need its own basket rule in
  Lane A too. Recommendation: yes, equal weight only — T2 is a sizing question and mixing
  it in here confuses selection with allocation.)
- **D2** — Block length 4 for the bootstrap, or tune it to the observed
  autocorrelation of the weekly series?
- **D3** — Should `flip_all` (every flip, pre-filter) be treated as a reportable arm, given
  it is not tradeable as specified (no risk cap, so no position size)? Recommendation: yes,
  as a **ceiling reference** only, clearly labelled untradeable — it bounds how much of
  Control's -1.11 pp is the filters versus the underlying flip signal.
- **D4** — NIFTY 50 source: `^NSEI` via yfinance (consistent with how the midcap benchmark
  is fetched) or the NSE archive? And should a fourth line — cash/liquid-fund at a flat
  weekly rate — be added, given Control sits in cash 30 of 104 weeks and the equity curve
  already compounds those weeks at 1.0?
