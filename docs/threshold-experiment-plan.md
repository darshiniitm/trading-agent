# Threshold Experiment — Risk-Cap Sweep — Plan (v1.0, registered)

**Status:** registered and implemented · 15 Sep 2026 · owner: Dharmin
**Experiment:** `threshold-experiment` · arms `threshold-experiment_15`, `_17.5`, `_20`, `_22.5`, `_25`, `_30`, `_40`, `_50`
**Control impact:** none. `config/rules.yaml` keeps `trade.max_r_pct: 0.15` and decides real trades. Every arm is shadow-only.

---

## 0. Summary

Every week, track what Control's basket would have returned if the risk cap in `build_trades()` (reject when `R/EP > max_r_pct`) were 15, 17.5, 20, 22.5, 25, 30, 40 or 50%.

Nothing new is screened. Control's weekly record (`results/forward_test/picks_<wk>.json`) already lists **every** survivor, including those the 15% cap rejected (`SHADOW_rejected_by_risk_cap`), and `track_forward grade` grades all of them with the same gap-aware exit. Each arm is a fixed split of that record:

- **SELECTED** — survivors with `R/EP ≤ cap`
- **REJECTED** — survivors with `R/EP > cap`

Loosening the risk cap is what `docs/forward-test-response-and-volume-plan.md` §4 and `.claude/HARNESS.md` §9 warn against doing on one week's evidence. It is registered here as a shadow experiment by Dharmin's explicit decision (15 Sep 2026), the same route T4 took; it never touches Control's picks or capital.

---

## 1. Decisions (settled 15 Sep 2026)

| # | decision | outcome |
|---|---|---|
| D1 | Cap grid | **15 / 17.5 / 20 / 22.5 / 25 / 30 / 40 / 50** |
| D2 | Naming | Plain names: experiment `threshold-experiment`, arms `threshold-experiment_<cap>`. No T-number. |
| D3 | `build_trades()` edit that removed the `R <= 0` guard | **Kept.** Arm membership mirrors the edited rule (reject only when `R/EP > cap`). Logged in `docs/forward_test_findings.md`. |
| D4 | Metric | **Equal-weight net return of SELECTED trades and of SHADOW/REJECTED trades, per arm.** No risk-normalised gate. |
| D5 | History | **Forward only.** A historical replay runs only if forward weeks show something worth checking, and then only as dev evidence. |

---

## 2. What the existing data says about the grid (counts only — no returns read)

From the 104-week flag replay (`results/feature_flags/replay/`, rows with `A01_vstop_flip_up = 1` and `A03_rsi_in_band = 1`):

**At a flip, R% is mechanical:** VStop resets its stop to `close − 2·ATR`, so for every survivor `R% of close = 200 · ATR / close` (exact across 576 rows). The risk cap is a cap on weekly volatility.

| R% of close | survivors in 104 weeks |
|---|---|
| ≤ 15 | 241 |
| 15 – 17.5 | 152 |
| 17.5 – 20 | 105 |
| 20 – 22.5 | 51 |
| 22.5 – 25 | 22 |
| 25 – 30 | 5 |
| > 30 | 0 (max 27.7) |

So: the 15% cap currently rejects 58% of survivors; `_17.5` to `_25` split the populated range; **`_30`, `_40`, `_50` would have been identical ("no cap") in every replay week** and can only diverge in a week with unprecedented volatility. They are recorded anyway because they cost nothing; `summary` reports `weeks_differing_from_control` so identical arms are visible, and BH correction only counts arms that actually differ.

---

## 3. Registration

| field | value |
|---|---|
| **Mechanism (only this changes)** | Per arm: SELECTED = Control's survivors with `(signal_close − vstop_line_SL) / signal_close ≤ cap/100`; REJECTED = the rest with a usable stop. Equal weight. EP = next-week open, SL = `vstop_line`, Control's gap-stop-aware 1-week exit, 0.5% round trip (all taken from Control's own grade). |
| **Identical to Control** | Universe, liquidity floor, VStop(10,2), RSI [50,65], exit rule, costs, sizing method, signal week. |
| **Hypothesis** | Names rejected by the 15% cap do no worse over one week than names it keeps, so a looser cap adds trades without lowering basket return. |
| **Weekly numbers per arm** | `selected_n`, `selected_basket_net_pct`, `rejected_n`, `rejected_basket_net_pct`, `selected_minus_control_pct`, `selected_minus_rejected_pct`, winners, worst trade. |
| **Kill** | At 26 forward weeks, an arm (other than `_15`) is retired if its paired `selected − Control` bootstrap CI upper bound < 0, **or** if its REJECTED-basket weekly mean CI upper bound < 0 (the cap was right to exclude those names). |
| **Graduation** | At 26 **forward** weeks, per arm: paired weekly `selected − Control` bootstrap CI lower bound > 0 (seed 42, 5,000 resamples) with BH-adjusted q < 0.05 across arms that differ from Control. One decision per arm, no second look. A graduating arm is a *proposal* to change `rules.yaml`, decided separately and explicitly — never automatic. |
| **Read points** | `FIRST_LOOK_WEEKS = 13` informational only; `REAL_READ_WEEKS = 26` decides. |

**Comparison rules:** a week with zero SELECTED names counts as 0.0% for that arm (cash) — never dropped. A week with zero REJECTED names has no rejected basket (nothing to observe) and is excluded from rejected-basket statistics only. Pair by `signal_week`. Only `forward` records count toward the gate; `late_backfill` never does.

**Recording mode:** `forward` only if **both** Control's picks file and the threshold record were written before the holding week's Monday 09:15 IST open.

---

## 4. Implementation (done)

| piece | what it does |
|---|---|
| `config/threshold_experiment.yaml` | Registry: experiment name, caps, `control_cap_pct: 15` (asserted equal to `rules.yaml`), inclusive boundary, checksum. Editing caps after `registry-lock` is refused — use a new experiment name. |
| `src/experiments/threshold.py` | Pure functions: `load_registry`, `arm_name`, `r_ratio`, `is_selected`, `build_membership`, `picks_fingerprint`, `check_record` (X1–X3), `grade_record` (X4–X6), `summarize`. |
| `tests/track_threshold.py` | CLI: `record --picks`, `backfill`, `grade --all-pending \| <file>`, `summary [--mode]`, `status`, `registry-lock`. Outputs to `results/threshold_experiment/`. |
| `scripts/weekly_selection_run.sh` | Step 1 adds `track_threshold grade --all-pending`; step 3a adds `track_threshold record --picks "$PICKS"` right after Control's record, before the flag trigger. |
| `.gitignore` | `!results/threshold_experiment/` so records are versioned. |
| `tests/test_threshold_experiment.py` | TX-01…TX-09, 15 tests, all passing. |

**Outputs** in `results/threshold_experiment/`: `threshold_<wk>.json` + `.csv` (immutable membership), `threshold_<wk>_graded.csv`, `threshold_ledger.csv` (append-only, one row per week × arm), `summary_latest.md`, `summary_<date>_<mode>.csv`.

**Invariants**

| id | check |
|---|---|
| X1 | `threshold-experiment_15` SELECTED == Control's `TRADE` tickers |
| X2 | SELECTED sets nested by increasing cap |
| X3 | every arm partitions the survivors that have a usable stop |
| X4 | Control's picks record unchanged since the threshold record (fingerprint excludes the `graded` block) |
| X5 | every member has a graded row |
| X6 | `_15` SELECTED basket equals Control's graded `basket_net_pct` |

---

## 5. Rollout

| when (IST) | what |
|---|---|
| Tue 15 Sep | Registered; code, tests, `.claude` and docs updated; `threshold_2026-09-07` recorded as `late_backfill`. |
| Sat 19 – Sun 20 Sep | Refresh data (`scripts/run_screen.py`), then `scripts/weekly_selection_run.sh` — grades 7 Sep, records signal week 14 Sep. |
| **Mon 21 Sep 09:15** | Deadline for the first **forward** threshold record (signal week 14 Sep). |
| weekly | The chain script grades last week and records this week. |
| ~ mid Dec 2026 | 13 forward weeks — first look, informational. |
| ~ mid Mar 2027 | 26 forward weeks — one kill/graduation decision per arm. |

---

## 6. Caveats carried by every number

Open-source data (`src/data/adapter.py: KNOWN_CAVEATS`): current share counts held constant, no delisted names (returns biased upward), index-list universe proxy, yfinance adjustments unverified. Wider-stop names are the most volatile names, where survivorship bias is likely strongest. At equal weight a 25%-R name carries ~1.7× the rupee risk of a 15%-R name — read higher returns in loose arms with that in mind.
