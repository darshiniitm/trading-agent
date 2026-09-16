# Open Decisions — Implementation Plan

**Status:** v1.0 — decisions settled Wed 16 Sep 2026 (§9), Phase 0–2 implemented (§11) · owner: Dharmin
**Covers:** the five open points on the Test-vs-Control dashboard, which trace back to `vstop-strategy-revision-plan.md` §9, `selection-and-analysis-improvement-plan.md` "Open decisions" and plan doc §6.
**Control impact:** none unless a decision below says so explicitly (only D4's RSI fix touches a Control file).

---

## 0. Where each point actually stands (checked against the repo today)

| # | Open point | Dashboard says | What the repo shows | Real remaining work |
|---|---|---|---|---|
| 1 | Daily bars | ✓ resolved (backfilled) | `data_cache/daily_ohlcv_1820d.parquet`: 501 tickers, **2019-05-13 → 2026-09-11**. Used only by T1's last-5-days scan. | Nothing to fetch. V3 (pullback entry) and V4 (same-week entry) are **not built**, and the backtest harness they would run in still has defects D1–D3 (probe tests fail today). |
| 2 | §3.8 v1 score | ✓ ship v1 now | `src/screen/candidate_score.py` live; scores logged on Control picks, near-misses and T1 candidates. | No build. Needs a **scheduled B6 rank-IC read** so "shipped" doesn't become "never checked". |
| 3 | Extended history | ? | Weekly cache starts **2021-07-12** (5 years). **Daily cache already reaches back to 2019-05** — about 2 extra years that have never been used for any return analysis. 85 of 501 tickers listed after 2022. | Decide the holdout. A no-fetch extension is sitting on disk. |
| 4 | V6 regime gate, V7 shorting | ? parked | Flag matrix already records `market_regime_bench_above_sma30w` every week (30-week SMA, not V6's 10-week trend). `D_vstop_flip_down` is recorded as a diagnostic. No V6/V7 code. | Registration + two small lanes each (dev backtest, forward shadow). |
| 5 | §3.8.2 guardrail thresholds | ? unvalidated | `HEADROOM_FULL_CREDIT_PCT = 5.0`, `LIQUIDITY_FULL_CREDIT_MULTIPLE = 2.0`, `BAND_POSITION_FULL_CREDIT = 0.5`. The same three cut-offs are recorded weekly as flags C01–C03 and graded by the flag matrix. | Define what "validated" means for a guardrail, then a dev calibration and a forward check. |

**Three things found along the way that affect this plan:**

- **Validation window is more spent than the revision plan records.** Since 29 Aug, the 104-week flag replay, T4's DEV/VALIDATE calibration and the RSI band study all read returns in **2024-08 → 2026-08**. It should now be treated as a development set, not a holdout. This strengthens the case for point 3.
- **Two graded forward records are not on disk.** `docs/forward_test_findings.md` cites `picks_2026-08-24.json` and `picks_2026-08-31` as graded, but `results/forward_test/` only holds `picks_2026-09-07`. `results/` is git-ignored, so they may be on another machine. They are the only uncontaminated evidence in the project; find them before anything below reads forward results.
- **Backtest defects still open.** `tests/test_backtest_engine.py` fails 6 defect probes (D1 gap-fill, D2 dropped zero weeks, D3 trend-hold stop, CAGR span) and `test_indicators_properties.py` fails D4. V3, V4, V6 and V7 all run through that harness.

---

## 1. Shared prerequisites (Phase 0–1)

These gate every point below. None changes what Control selects.

### P0 — Housekeeping (S, this week)
1. Commit the current uncommitted work (threshold experiment, `build_trades()` change, dashboard section script) so AU03 stops flagging drift and everything below starts from a clean tree.
2. Locate `picks_2026-08-24.json` / `picks_2026-08-31.json` and their T1 records; copy into `results/forward_test/`. If they can't be found, append a findings entry saying so — never reconstruct them.
3. **Evidence ledger** — new `docs/evidence-ledger.md`: one row per study that read returns, with window, date, and what was decided. Seed it with: 104-week walk-forward, RSI band study, flag replay, T4 calibration, threshold-experiment counts (counts only). This is the lightweight version of A4's segment lock, and it's what the multiple-testing denominator is counted from.

### P1 — Backtest harness defect fixes (M)
Fix in `src/backtest/harness.py`, in the order A1 set, each with its probe test turning green and a findings entry restating baseline numbers:

| id | fix | touches Control? |
|---|---|---|
| D2 | `weekly_portfolio_returns` reindexes onto the full fold calendar, zero-pick weeks = 0.0 | no |
| D1 | `simulate_week_forward` exits at `min(open, SL)` on a gap-through (same rule `_grade_rows` already uses) | no |
| D3 | `simulate_trend_hold` compares bar *i*'s low against bar *i−1*'s stop | no |
| D5 | funnel logs `build_trades()` rejections with reason | no (additive output) |
| D6 | graded trades recompute `R` and `target` off the actual fill | no |
| D4 | flat-series RSI returns 50 | **yes** — `src/indicators/rsi.py` is Control. Practically never fires for a survivor, but it is a Control-file change → decision D4 |

Gate: full suite green except any probe you decide to leave open; baseline 104-week numbers restated once, logged in the ledger.

### P2 — Experiment registry and segment lock (M)
- `config/experiments.yaml`: id, hypothesis, mechanism, kill criterion, data segment, registered date. `src/backtest/` refuses to write results for an unregistered id. Existing registries (`feature_flags.yaml`, `threshold_experiment.yaml`) stay where they are and are referenced by id.
- `src/data/segments.py`: named segments with date bounds, and a read counter written into each result file. A run against `holdout` requires `--segment holdout --i-understand-this-is-one-pass`.

| segment | weeks (signal Fridays) | status after this plan |
|---|---|---|
| `dev` | 2022-02 → 2026-08 (weekly cache after 30-bar warm-up) | free to look |
| `holdout_ext` | ~2019-12 → 2021-06, built from the daily cache (point 3) | **one pass, finalists only** |
| `forward` | 2026-09-14 onward | gate evidence |

---

## 2. Point 1 — Daily bars → entry timing (V3, V4)

**Goal:** test whether the −0.87% one-week give-back after the flip week can be harvested (V3) or avoided by entering sooner (V4). Daily data is on disk; the work is a daily-resolution entry/exit engine.

**Build (L)**
1. `src/data/resample.py` — daily → Monday-dated weekly bars. **Integrity test:** over 2021-07 → 2026-09 the resampled bars match the cached yfinance weekly bars (open/high/low/close within 0.1%, volume within 1%) for ≥ 99% of ticker-weeks; mismatches listed, not silently dropped. This also unlocks point 3.
2. `src/backtest/entry.py`
   - `pullback_limit_fill(daily, signal_friday, limit=signal_close, window_days=5)` → fill price/date or `no_fill`.
   - `same_week_entry(daily, flip_date)` → next day's open after the daily bar on which the weekly rule would first be true (reuses `daily_rule_spec()` + `run_screen()`, never a second filter implementation).
3. `src/backtest/daily_exit.py` — stop/exit on daily bars: stop checked per day at `min(open, SL)`, exit at the horizon's last close. One engine for V3, V4 and (later) V1/V2.
4. Diagnostic pack fields per trade (A2): `signal_week_return`, `fill_price`, `fill_date`, `fill_rate` (V3), `gap_flag`, `days_since_flip` (V4).

**Registration (before any run)**

| id | mechanism | kill |
|---|---|---|
| V3 | Fill only if price trades ≤ signal-week close within the next 5 sessions; hold to that week's close (1-week horizon only until V2 exists — decision D5) | fill rate < 40%, **or** filled-trade expectancy ≤ baseline on the same weeks |
| V4 | Enter at the next open after the day the weekly rule first confirms; same 1-week exit | expectancy not above baseline on the same weeks |

**Relationship to T1:** V4 is T1's detection plus an earlier entry. T1 stays a separate forward shadow arm; V4 is a dev backtest. Share the detection code (`record_t1_shadow`'s rolling scan) rather than duplicating it.

**Tests:** synthetic daily panels for fill/no-fill at the limit boundary, gap-through-stop on day 1, holiday weeks (4 sessions), resample integrity on a fixture.

---

## 3. Point 2 — §3.8 v1 score: make "shipped" checkable (S)

No build. Add a pre-registered read schedule:
- **What:** B6 weekly Spearman rank-IC of `candidate_score` vs 1-week net return, separately for (a) T1 candidates and (b) Control picks + near-misses; plus rank-IC of `edge_score` alone, so point 5 can see what the guardrail multiplier adds.
- **When:** `track_forward summary` already computes confidence rank-IC; extend it to `candidate_score` and `edge_score`. Informational at 13 graded T1 weeks, decision at 26.
- **Kill:** at 26 weeks, mean weekly rank-IC CI includes zero for `candidate_score` on T1 → score stays a logged column only, not an input to T3.

---

## 4. Point 3 — Extended history

### Options

| option | what | cost | clean? | main problem |
|---|---|---|---|---|
| **A. Keep the spent window** | Nothing new | none | no — 2024-08 → 2026-08 has been read by four studies | no untouched evidence for a final call |
| **B. Use the daily cache's 2019–2021 years** *(recommended now)* | Resample daily → weekly, build a `holdout_ext` segment ~2019-12 → 2021-06 (~80 signal weeks after warm-up) | S–M, no network | **never read for returns** | includes the Mar-2020 crash and 2020–21 recovery (good regime diversity) but survivorship bias is heavier the further back you go |
| **C. Pull 10+ years** | yfinance `period="max"` weekly + daily for the universe | M–L, needs your Mac's network; can't be probed from this session | untouched | severe biases for a fixed rupee band (below) |

### Why option C is weaker than it sounds on open-source data
1. **Survivorship grows with age.** The universe is today's index constituents. In 2015 many of them were small caps and many 2015 mid-caps have since fallen out or delisted — none are in the data. Returns are biased upward exactly where the holdout is supposed to be most honest.
2. **The ₹10,000–50,000 cr band is nominal.** Market caps have grown several-fold since 2015, so a fixed rupee band selects much larger-relative companies in 2015 than in 2026. A long holdout needs the band scaled by an index level (e.g. Nifty Midcap 150), which is itself a rule change to register.
3. **Shares outstanding are today's**, so historical market cap drifts with every buyback, QIP or merger over ten years.
4. **Listing age:** 85 of 501 tickers aren't in the data before 2022; the pre-2016 universe would be a fraction of today's.

### Plan
- **Now (option B):** build `holdout_ext` from the daily cache (depends on §2 step 1 resample). Register it in `segments.py` as one-pass. Quantify its bias before anyone looks at a return: per week, how many of today's 501 had data and how many sat in the band.
- **Probe for C (S), no decision needed yet:** a script run on your Mac that fetches `period="max"` for the benchmark and a 30-ticker stratified sample, and reports first-date distribution only. If a finalist ever survives dev and `holdout_ext`, decide then whether C is worth building with an index-scaled band.
- **Never:** pool `holdout_ext` into dev after it's been read, or re-run it after adjusting a finalist.

---

## 5. Point 4a — V6 domestic regime gate — **OUT (D2, 16 Sep 2026); kept below for the record, not built**

**Evidence behind it:** universe returns −0.21% in weeks the screen fires vs +0.95% when it doesn't (validation window, now dev).

**Registration (before any run)**

| field | value |
|---|---|
| id | V6 |
| rule | New longs only when NIFTY MIDCAP 150 weekly close on the signal Friday is **above its 10-week SMA** (the definition in revision plan §4). Otherwise that week's basket is cash (0.0%). |
| diagnostic only | the 30-week SMA flag already recorded by the flag matrix — reported, not a second variant |
| kill (dev) | gated basket's weekly mean ≤ ungated baseline on the same weeks, or gate removes > 60% of weeks |
| forward | shadow only; 26 forward weeks, paired `gated − Control` CI lower bound > 0 |

**Lane 1 — dev backtest (S after P1):** apply the gate as a week filter on the D1/D2-fixed walk-forward over `dev`. Report weeks gated off, trades removed, gated vs ungated paired weekly difference.

**Lane 2 — forward shadow (S):** new `tests/track_regime.py` modelled on `track_threshold.py`. `record --picks` stores the benchmark close, the 10-week SMA and `gate_on` at record time (benchmark bars only, date ≤ as_of); `grade` derives `gated_basket = Control basket if gate_on else 0.0` from Control's own graded block. Chained in `weekly_selection_run.sh` after Control's record. Same X1-style check: gate on ⇒ gated basket == Control basket.

**Decision needed (D2):** you previously ruled out macro inputs. V6 uses only the benchmark of the universe being traded. In or out?

---

## 6. Point 4b — V7 short side

**Current market structure (re-check before any trading decision):** overnight shorting of cash equities in India requires borrowing through SLB, which SEBI said in Aug 2026 it is reviewing; the practical short route today is single-stock futures, which exist only for F&O-eligible names — a subset of this mid-cap universe. That makes a tradeable short leg a different instrument, cost base and universe, not a mirror of the long screen.

**Registration**

| id | what | purpose |
|---|---|---|
| V7a — alpha decomposition | For Control's own trades, split next-week return into benchmark beta × benchmark return + residual, vs the eligible universe | Tests whether the −1.10% alpha is beta/timing (fixable by V6) or stock-specific. No new signal. |
| V7b — short-signal diagnostic | Mirror rule: `flip_down` AND RSI in [35, 50], same universe/liquidity; short at next open, stop = VStop line above, 1-week exit, cost 0.5% + borrow placeholder 0.25%/week | If both V7b and the long side are negative, something structural (liquidity, gap risk) eats both. |

**Rules:** diagnostic only — **never promoted to a trade** without a separate study covering F&O eligibility, futures roll/basis, margin and borrow cost (decision D3). Dev segment only; not counted against the 7-variant budget since it cannot graduate.

**Build (M after P1):** `src/backtest/short_side.py` (mirror predicates via a deep-copied spec, same pattern as `daily_rule_spec`; short-side grading with gap-up-through-stop fill at `max(open, SL)`), plus V7a as a function over graded trades and the eligible-universe returns the flag replay already produces.

---

## 7. Point 5 — Validating the §3.8.2 guardrail thresholds

**The key design choice:** guardrails are risk discounts, not edge. Validating them against mean return would re-blend them into the edge score, which §3.8's architecture principle forbids. Each guardrail is validated against the specific risk it claims to measure:

| guardrail | current full-credit threshold | claims to measure | validation metric |
|---|---|---|---|
| risk-cap headroom | ≥ 5.0 pp below cap | stop distance / volatility risk | 1-week stop-hit + gap-stop rate, and worst-decile loss, by headroom bucket |
| liquidity multiple | ≥ 2.0× the ₹10 cr floor | execution / gap risk | |open − signal close| gap size and gap-stop rate by bucket |
| market-cap band position | ≥ 0.5 of the way to band centre | durability in the universe | probability the name is **still in the band 4 and 13 weeks later** — needs no returns at all |

**Protocol**
1. **Register first:** grid per threshold — headroom {2.5, 5, 7.5} pp; liquidity {1.5, 2, 3}×; band position {0.25, 0.5, 0.75}. Selection rule: the smallest threshold beyond which the risk metric stops improving by more than a pre-set margin (10% relative), chosen on `dev` only. Ramp shape stays linear; only the full-credit point is calibrated.
2. **Dev calibration (M):** `track_flags replay --start 2022-02 --end 2024-08` produces eligible-row features and grades on dev weeks the flag replay hasn't used. New `scripts/calibrate_guardrails.py` computes the three metrics per bucket and applies the selection rule. Band-position durability runs over the whole cache, since it reads no returns.
3. **Coupling with the threshold experiment:** headroom is defined against the 15% cap. If a threshold arm ever graduates, headroom must be recomputed against the new cap — note it in `candidate_score.py`, don't pre-empt.
4. **Freeze:** write the chosen thresholds as `v2` constants with a registry checksum; v1 constants stay in the ledger. Existing flags C01–C03 keep recording at v1 thresholds for continuity (registry v1); new flags go in a flag registry v2 bump.
5. **Forward check:** at 26 weeks, (a) risk metrics by guardrail bucket on T1 candidates + Control survivors hold the dev ordering, and (b) point 2's comparison: does `candidate_score` reduce downside (stop-out rate in the top tercile) relative to `edge_score` without lowering rank-IC? If not, the multiplier is decoration → keep the columns, drop the product.

---

## 8. Sequencing

| phase | work | depends on | size | gate to next |
|---|---|---|---|---|
| **0** | P0 housekeeping, evidence ledger, register V3/V4/V6/V7/guardrail grid, point-2 read schedule | — | S | decisions D1–D6 answered |
| **1** | P1 defect fixes, restate baseline | 0 | M | suite green |
| **2** | P2 registry + segments; daily→weekly resample + integrity; `holdout_ext` built and bias-quantified (no returns read) | 1 | M | integrity ≥ 99% |
| **3** | V6 forward shadow lane live (cheap, starts the clock) | 0 | S | first forward record before a Monday open |
| **4** | Dev runs: V6 lane 1, V7a, guardrail calibration | 1, 2 | M | results logged in ledger |
| **5** | Daily entry engine → V3, V4 on dev; V7b | 2 | L | any variant beats baseline with a sane mechanism |
| **6** | ≤ 2 finalists → **one** `holdout_ext` pass against revision plan §6.2 gates | 4, 5 | S | pass, or stop per revision plan §8 |
| **7** | Option C probe, only if a finalist passed 6 | 6 | S | your call |

Phase 3 can start in parallel with Phase 1 because it only reads Control's picks and the benchmark.

**Variant budget (revision plan §4: 7, Bonferroni p < 0.007):** V3, V4, V6 count. V7 is diagnostic and can't graduate. Guardrail calibration isn't a variant (it changes a shadow score, not a trade rule). V1/V2 still hold two budget slots.

---

## 9. Decisions (settled Wed 16 Sep 2026)

| # | decision | outcome | effect on this plan |
|---|---|---|---|
| D1 | Holdout | **Data from 2019 onward.** | `scripts/backfill_history.py --start 2019-01-01` (run on the Mac — needs network) fills 2019-01 → 2019-05; until then the daily cache (from 2019-05-13) is used. Weekly bars are always resampled from daily. `holdout_ext` = signal weeks up to 2021-06-28, one pass. Option C (10+ years) dropped. |
| D2 | V6 regime gate | **Out.** | §5 is not built. The flag matrix keeps recording `market_regime_bench_above_sma30w` as a diagnostic column only. |
| D3 | V7 | **Do it.** | V7a (alpha decomposition) and V7b (short-signal mirror) registered as diagnostics; not tradeable without a separate F&O/borrow study. |
| D4 | Defect fixes | **Fix the recommended ones: D1, D2, D3, D5, D6.** | Done (§11). D4 (flat-series RSI, a Control file) left open. |
| D5 | Horizon first | **Yes — add V2.** | V2 registered; V3's longer-horizon arm depends on V2's best N. |
| D6 | Guardrail validation | **Both: own risk metric AND returns.** | Registered as a dual criterion in `config/experiments.yaml` id `G`: the risk-metric selection rule, plus returns non-inferiority (above-threshold minus below-threshold weekly net ≥ 0 with CI lower bound ≥ −0.5 pp). |

---

## 10. Caveats

All results carry `src/data/adapter.py: KNOWN_CAVEATS`. `holdout_ext` is older than every other segment and so carries the most survivorship bias: a variant that fails there is dead; a variant that passes there has cleared a biased-upward bar and still needs forward confirmation.

**Sources for §6:** [Business Today — SLBM, short selling framework under review (Aug 2026)](https://www.businesstoday.in/markets/stocks/story/slbm-short-selling-framework-under-review-to-deepen-cash-market-says-sebi-chairman-550042-2026-08-19) · [Business Standard — SEBI to review short-selling framework](https://www.business-standard.com/markets/news/sebi-to-review-short-selling-slb-framework-to-deepen-capital-markets-126061201070_1.html) · [NSE — equity derivatives selection criteria](https://www.nseindia.com/static/products-services/equity-derivatives-selection-criteria)

---

## 11. Implementation status (16 Sep 2026)

| phase | item | status |
|---|---|---|
| 0 | Evidence ledger (`docs/evidence-ledger.md`) | ✅ |
| 0 | Register V2, V3, V4, V7a, V7b, G in `config/experiments.yaml`, checksum-locked | ✅ budget used 3 of 7 |
| 0 | Commit current work; locate `picks_2026-08-24/31.json` | ⏳ Dharmin |
| 1 | D1, D2, D3, D5, D6 fixed in `src/backtest/harness.py`; probes green; `tests/test_harness_fixes.py` | ✅ |
| 1 | Baseline restated (same 104 folds) | ✅ trades unchanged (−1.285%/trade); portfolio 74 → 104 weeks, CAGR −57.7% → −45.7%, Sharpe −2.70 → −2.24, max DD −73.6%; 335 risk-cap rejections now logged |
| 1 | D4 (flat-series RSI) | left open by decision |
| 2 | `src/data/resample.py` daily → weekly + integrity check | ✅ 99.66% match after excluding D7 weeks and the in-progress week (95.6% raw) |
| 2 | `src/data/segments.py` (dev / holdout_ext / forward, one-pass guard, read ledger) | ✅ |
| 2 | `tests/offline.py:env_extended()` (2019+ weekly bars from daily) | ✅ uses `daily_ohlcv_1820d.parquet` (from 2019-05-13) |
| 2 | `scripts/backfill_history.py --start 2019-01-01` | ✅ written; ⏳ needs to be run on the Mac (no network in this session) |
| 2 | `holdout_ext` sizing, counts only | ✅ 83 signal weeks (2019-12-02 → 2021-06-28); 133–189 names in band vs 264 today |
| 4–5 | V2 engine → V3, V4; V7a, V7b; G calibration | not started |

**New finding — D7.** yfinance weekly bars in weeks whose Monday is an NSE holiday report the previous Friday's close as the open (4,519 ticker-weeks, ~3.7%). Every grader that takes EP from the weekly bar is affected — `track_forward._grade_rows`, `simulate_week_forward`, `grade_matrix`, and the threshold experiment. **Mon 14 Sep 2026 was an NSE holiday, so the 2026-09-07 record's grade will use Fri 11 Sep's close as EP.** Proposed fix (needs a decision because it changes Control's grader): take EP and the week's low from the daily bars of the holding week when they exist, falling back to the weekly bar otherwise; re-grade nothing retroactively, log the change.

**Next steps, in order:** decide D7 → run `backfill_history.py` on the Mac → build the V2 engine on `env_extended()` over `dev` 2021-07 → 2024-08 (the unread part first) → V3/V4 → V7a/V7b → G.
