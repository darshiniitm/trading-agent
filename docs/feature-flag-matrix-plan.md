# Feature-Flag Condition Matrix + T4 Test Arm — Implementation Spec (v1.0)

**Audience:** Claude Code, implementing inside this repo (`trading-agent`).
**Author of intent:** Dharmin. **Written:** Tue 15 Sep 2026.
**Status:** Approved design, not yet implemented. §13 lists decisions with defaults — implement with the defaults unless Dharmin has overridden them in this file.

---

## 0. How to use this document

1. Read `.claude/HARNESS.md` and `.claude/GLOSSARY.md` **first**. Every rule there still applies; this spec adds rules, it never relaxes one. If anything below appears to conflict with `HARNESS.md`, HARNESS wins — stop and flag it.
2. Implement in the phase order in §12. Each phase has acceptance criteria; do not start the next phase until the current one passes `pytest`.
3. When the spec says **MUST**, it is a guardrail enforced by a test (§10). When it says **default**, it is a pre-registered choice that can only change via a new registry version (§8.4).
4. Don't touch `config/rules.yaml`. Don't change `run_screen()`/`build_trades()` selection or sizing. Don't edit or delete any existing `results/forward_test/picks_*` file.

---

## 1. What we are building (one paragraph)

Every week, take **every stock that passes the base gate** (market-cap band ₹10,000–50,000 cr **and** liquidity ≥ ₹10 cr median 8-week turnover — the `liquidity_filter` stage of `run_screen()`, ~264 names). For each stock, evaluate a **registry of named conditions** ("feature flags"). Store each as **1 = condition met / 0 = not met** (blank = not evaluable). Add `flags_met` = how many countable conditions the stock satisfies. Write this as an **immutable weekly process output file**, grade it a week later with forward returns, and accumulate a **scorecard** that shows which conditions actually carry information. On top of the matrix, register a shadow **Test arm T4 (flag-count selection)** with a pre-registered graduation gate so the matrix can eventually earn real capital — or be killed — by evidence, not judgment. The flag run is **triggered by the weekly stock-selection run itself** (Control's `track_forward record`), never on its own separate schedule. It uses the same `as_of`, the same data snapshot and the same session. A deterministic Python pipeline does the work, and a Claude Code skill/agent does the audit and write-up.

### 1.1 What this does NOT change

- Control (`config/rules.yaml`, VStop(10,2), RSI[50,65], 15% risk cap, equal weight) — frozen.
- `run_screen()` selection output and `build_trades()` — byte-identical (tested, §10 T-04).
- Existing `tests/track_forward.py` record/grade/T1 cadence — untouched; the flag pipeline runs alongside it.

---

## 2. Definitions

| Term | Meaning |
|---|---|
| **Base gate** ("valuation criteria") | `mktcap_cr ∈ [universe.market_cap_cr.min, max]` AND `median_weekly_turnover_cr ≥ universe.liquidity.min`. Thresholds read from `config/rules.yaml` at runtime — never hard-coded. |
| **Eligible set** | All tickers surviving the base gate for a given `as_of` (= `run_screen()` funnel stage `liquidity_filter`). One matrix row per eligible ticker. Stocks with `< data.min_bars_required` bars stay in the file with all flags blank and `eligible_reason = insufficient_history`. |
| **Signal week / `as_of`** | The Monday-dated weekly bar whose Friday close is the signal (same convention as `picks_<date>.json`, e.g. `2026-09-07` = Mon 7–Fri 11 Sep). |
| **Flag** | A registered, versioned boolean condition with id, family, formula, inputs, and `countable` true/false. |
| **Countable flag** | Contributes to `flags_met`. Oriented so `1` is always the long-side "desirable" reading. |
| **Diagnostic column** | Recorded for analysis (e.g. `rsi_above_band`) but never counted. |
| **`flags_met`** | Sum of countable flags equal to 1. |
| **`flags_evaluable`** | Number of countable flags that are 0 or 1 (not blank). |
| **`flags_pct`** | `flags_met / flags_evaluable` (blank if `flags_evaluable == 0`). |
| **Registry version** | Integer in `config/feature_flags.yaml`. Counts and scorecards are only comparable **within** one version. |
| **Recording mode** | `forward` (recorded before the holding week's Monday 09:15 IST open), `late_backfill` (recorded after that open — evidence, but excluded from gate statistics), `replay` (historical as_of reconstructed from cache — dev/validation only). |

---

## 3. Flag registry v1

### 3.1 Countable flags (13)

All inputs come from values `run_screen()` / `compute_features_for_ticker()` / `sector_rs` / `candidate_score.guardrails()` already compute. **No new indicator math in v1.**

| id | family | condition (1 when…) | inputs | notes |
|---|---|---|---|---|
| `A01_vstop_flip_up` | A · Control signal | `flip_up == True` on the as_of bar | vstop | Rare (≈1% of rows). |
| `A02_vstop_uptrend` | A | `uptrend == True` | vstop | State, not event. |
| `A03_rsi_in_band` | A | `rsi_lo ≤ rsi ≤ rsi_hi` (inclusive; bounds via `_rsi_band_bounds(rule_spec)`) | rsi | |
| `A04_risk_cap_ok` | A | `uptrend` AND `0 < (close − vstop_line)/close ≤ trade.max_r_pct` | close, vstop_line | At record time `build_trades()` uses EP = close, so this equals Control's cap exactly then. Downtrend → **0** (no valid long SL), not blank. |
| `B01_sector_rs_4w_pos` | B · Confidence components | `rs_4w > sector.outperforming.rs_gt` | sector_rs | Sector missing from RS table → blank. |
| `B02_sector_top_k` | B | `outperforming == True` (rs > rs_gt AND rank ≤ top_k) | sector_rs | |
| `B03_sector_rs_13w_pos` | B | `rs_13w > 0` | sector_rs | |
| `B04_volume_expansion` | B | `volume / avg_vol_8w ≥ 1.5` | volume, avg_vol_8w | `avg_vol_8w` 0/NaN → blank. |
| `B05_trend_quality_strong` | B | `uptrend` AND `(close − vstop_line)/atr ≥ 2.0` | close, vstop_line, atr | Downtrend → 0. ATR NaN → blank. |
| `B06_rsi_sweetspot_core` | B | `triangular_kernel(rsi, rsi_lo, rsi_hi) ≥ 0.5` (≈ 53.75–61.25) | rsi | Reuse `src/trade/builder.py:triangular_kernel`. |
| `C01_risk_headroom_5pp` | C · Guardrail headroom | `uptrend` AND `risk_cap_headroom_pct ≥ HEADROOM_FULL_CREDIT_PCT` (5.0) | via `guardrails()` | Downtrend → 0. |
| `C02_liquidity_2x` | C | `liquidity_multiple ≥ LIQUIDITY_FULL_CREDIT_MULTIPLE` (2.0) | via `guardrails()` | |
| `C03_cap_band_central` | C | `band_position ≥ BAND_POSITION_FULL_CREDIT` (0.5) | via `guardrails()` | |

Thresholds for B04 (1.5×) and B05 (2.0 ATR) are **a-priori defaults**, chosen before any data was looked at. They live in `config/feature_flags.yaml`, not in code. C-family thresholds MUST be imported from `src/screen/candidate_score.py` constants, not duplicated.

**Known structure (do not "fix" by reweighting):** C01 ⇒ A04 ⇒ A02 and B05 ⇒ A02 are nested, so uptrend names get a structural count boost. This is accepted in v1 — the count is deliberately unweighted; weights are a *conclusion* from the scorecard (§6.5), never an input (same principle as plan v0.7 §3.8). The scorecard MUST publish the flag correlation matrix so this is visible.

### 3.2 Diagnostic columns (recorded, not counted)

`D_rsi_above_band` (rsi > rsi_hi), `D_rsi_below_band` (rsi < rsi_lo), `D_vstop_flip_down`, `control_status` (`TRADE` / `SHADOW_rejected_by_risk_cap` / `NEAR_MISS_failed_<…>` / `NONE` — derived from the same run), `survivor_count_week`, `eligible_count_week`, `market_regime_bench_above_sma30w` (context, same value for every row: benchmark close > 30-week SMA of benchmark close, PIT-sliced).

### 3.3 Family E — planned for registry v2 (do NOT implement in Phase 1)

New indicator module `src/indicators/structure.py`, computed on the same PIT-sliced panel, each with unit tests: `E01_flip_within_3w_still_up`, `E02_above_sma30w`, `E03_within_10pct_52w_high`, `E04_return_13w_pos`. Fundamental valuation flags (P/E, P/B, ROE, debt) are **out of scope** until a fundamentals data source exists (§13 D7).

### 3.4 Registry file: `config/feature_flags.yaml`

```yaml
# Feature-flag registry. NOT Control. Editing any threshold or adding/removing a
# countable flag REQUIRES bumping registry_version (enforced by test T-01).
registry_version: 1
frozen_on: 2026-09-15
base_gate: from_rules_yaml          # market_cap_cr + liquidity, read at runtime
flags:
  - id: A01_vstop_flip_up
    family: A
    countable: true
    description: "VStop flip_up on the as_of weekly bar"
    rule: {type: bool_field, field: flip_up}
  - id: B04_volume_expansion
    family: B
    countable: true
    rule: {type: ratio_gte, num: volume, den: avg_vol_8w, threshold: 1.5}
  # ... all 13 countable + diagnostics, one entry each
t4:
  k: null            # set ONCE by the DEV protocol in §7.3, then frozen
  k_grid: [7, 8, 9, 10, 11]
  max_names: 10
  tie_break: [flags_met_desc, median_weekly_turnover_cr_desc, ticker_asc]
checksum: <sha256 of the flags+t4 block, written by `track_flags registry-lock`>
```

Flag rules are evaluated by small, named Python functions in `src/flags/rules.py` keyed by `rule.type` — **no `eval()`** of free-form strings.

---

## 4. Architecture — files to create / modify

### 4.1 Create

| Path | Purpose |
|---|---|
| `config/feature_flags.yaml` | Registry (§3.4). |
| `src/flags/__init__.py` | |
| `src/flags/registry.py` | Load + validate registry, compute checksum, expose countable/diagnostic lists. |
| `src/flags/rules.py` | Pure functions `(row: dict, ctx: dict) -> 1 | 0 | None` per rule type. |
| `src/flags/matrix.py` | `build_flag_matrix(as_of, rule_spec, registry, adapter, universe_df, panels, shares) -> (DataFrame, manifest)`. Calls `run_screen(..., include_eligible_features=True)` — the only screening path. |
| `src/flags/grade.py` | Forward returns for every row; reuses `tests/track_forward.py:_grade_rows` for the Control-style exit. |
| `src/flags/t4.py` | T4 selection from a matrix + T4 basket grading. |
| `src/flags/scorecard.py` | Week-clustered lift, rank-IC, count buckets, BH correction, correlation matrix, maturity labels. |
| `src/flags/checks.py` | Invariants I1–I10 (§9.2); returns a structured pass/fail list. |
| `src/flags/audit.py` | Deterministic audit checks AU01–AU10 and `noteworthy` rules → `audit_<wk>.json` (§11.3.1). |
| `src/flags/findings.py` + `src/flags/templates/findings_entry.md.tmpl` | Template-rendered findings draft and idempotent append (§11.3.1). |
| `src/flags/timing.py` | IST clock, week-closed check, forward vs late mode, Monday-open deadline. |
| `tests/track_flags.py` | CLI (§11.1), mirroring `tests/track_forward.py` conventions. |
| `tests/test_flags_*.py` | Test suite (§10). |
| `scripts/weekly_selection_run.sh` | The one entry point for the weekly stock-selection run. It runs Control's record and then the flag matrix as a chained step (§11.4). |
| `.claude/skills/weekly-flag-matrix/SKILL.md` | Operating procedure skill (§11.2). |
| `.claude/agents/flag-run-auditor.md` | Read-only audit subagent (§11.3). |

### 4.2 Modify (additive only)

| Path | Change | Constraint |
|---|---|---|
| `src/screen/engine.py:run_screen()` | Add kwarg `include_eligible_features: bool = False`. When True, also return `eligible_features`: one row per `stage1_rows` ticker with `ticker, name, sector, mktcap_cr, median_weekly_turnover_cr`, all `compute_features_for_ticker` fields (or `insufficient_history`), the per-signal `predicate_results`, and the sector-RS columns merged by sector (`rs_4w, rs_13w, rs_rank, outperforming`). | Default False. Every existing key in the return dict MUST be identical with the flag on or off (test T-04). This is the only sanctioned way to get features for non-survivors — do **not** re-implement the cap/liquidity stages elsewhere (HARNESS §2). |
| `.gitignore` | Add `!results/feature_flags/` after `results/` so records are version-controlled (git history = tamper evidence). | Only if §13 D3 is accepted (default yes). |
| `docs/forward-test-response-and-volume-plan.md` | Add §3.9 "T4 — Flag-count selection" registration (copy §7 of this spec) **before** the first replay run. | Registration must predate results. |
| `CLAUDE.md` | Add rows to architecture map + skill list. | |
| `.claude/skills/rebuild-test-control-dashboard/SKILL.md` | Add T4 + flag scorecard as data sources. | |
| `.claude/skills/weekly-forward-test/SKILL.md` | Add a step right after "Record Control" and "Grade": run `python -m tests.track_flags on-selection --picks <path just written>` (§11.4). Also point the procedure at `scripts/weekly_selection_run.sh`. | Procedure text only. `tests/track_forward.py` code is **not** changed; the chaining lives in the shell script and the skill. |

---

## 5. Pipeline — stages of one weekly run

The flag pipeline is **downstream of stock selection**. It starts only after Control's `record` for that week has produced (or already has) `results/forward_test/picks_<wk>.json`. `as_of` is **read from that file's `signal_week_start`**, not recomputed. That way the flag matrix and the trade picks always describe the same week and the same data. If no picks file exists for the week, the flag pipeline refuses to record (exit code 3, "no selection run for this week").

```
Stage 0  PREFLIGHT   picks_<wk>.json exists? as_of := its signal_week_start; week-closed?, mode forward|late (flag record's own created time vs holding-week Monday 09:15 IST), lockfile, registry checksum
Stage 1  DATA        reuse the cache the selection run just used (no second refresh); assert meta.fetched_at > as_of Friday 15:30 IST
Stage 2  GRADE       grade every ungraded flags_<week>.csv whose holding week has closed (+ T4 basket)
Stage 3  RECORD      build_flag_matrix(as_of) -> flags_<as_of>.csv + manifest (refuse overwrite)
Stage 4  T4 PICKS    select T4 shadow basket from the new matrix (only once t4.k is frozen)
Stage 5  CHECKS      invariants I1–I10; any FAIL -> status FAILED, keep files, alert, stop
Stage 6  LEDGER      append to flag_ledger.csv (dedupe key), refresh scorecard
Stage 7  AUDIT       run_status_latest.md + run_log.jsonl; deterministic audit tools (§11.3.1), operated by flag-run-auditor
```

Stages 0–6 are **deterministic Python, no LLM**. Stage 7's agent only reads outputs, verifies, and drafts prose. The agent MUST NOT compute or alter any number.

Every stage is idempotent: re-running a completed stage is a no-op that logs `skipped_already_done`.

---

## 6. Output specifications (the "process output file")

All under `results/feature_flags/`. `<wk>` = `as_of` date `YYYY-MM-DD`. Subfolder `replay/` holds replay-mode files with identical schemas.

### 6.1 `flags_<wk>.csv` — the weekly matrix (immutable)

One row per eligible ticker, sorted by `flags_met desc, ticker asc`. Columns in this order:

| group | columns |
|---|---|
| identity | `signal_week, registry_version, recording_mode, ticker, name, sector, eligible_reason` |
| base gate raw | `mktcap_cr, median_weekly_turnover_cr` |
| raw features | `close, open, high, low, volume, avg_vol_8w, atr, vstop_line, uptrend, rsi, rs_4w, rs_13w, rs_rank, R_pct_of_close, risk_cap_headroom_pct, liquidity_multiple, band_position, volume_ratio, trend_quality` |
| countable flags | `A01_… … C03_…` — values `1`, `0`, or empty |
| summary | `flags_met, flags_evaluable, flags_pct, flags_missing_ids` (semicolon list) |
| diagnostics | `D_rsi_above_band, D_rsi_below_band, D_vstop_flip_down, control_status, survivor_count_week, eligible_count_week, market_regime_bench_above_sma30w` |
| T4 | `t4_selected` (1/0, empty until `t4.k` frozen), `t4_rank` |

Rounding: prices 4 dp, ratios 4 dp, pct 3 dp. Empty = not evaluable; **never write 0 for missing.**

### 6.2 `flags_<wk>.manifest.json` (immutable)

```json
{
  "record_id": "flags_2026-09-07",
  "signal_week": "2026-09-07",
  "holding_week": "2026-09-14",
  "recording_mode": "late_backfill",
  "created_utc": "...", "created_ist": "...",
  "monday_open_deadline_ist": "2026-09-14T09:15:00+05:30",
  "registry_version": 1, "registry_checksum": "sha256:…",
  "rules_yaml_sha256": "…", "git_commit": "…", "git_dirty": true,
  "data": {"weekly_meta_fetched_at_utc": "…", "n_panels": 0, "benchmark_ticker": "NIFTYMIDCAP150.NS"},
  "funnel": {"candidate_universe": 0, "universe_market_cap_band": 0, "liquidity_filter": 0, "vstop_flip": 0, "survivors_after_rsi_band": 0},
  "counts": {"rows": 0, "flags_met_histogram": {"0": 0, "1": 0}, "prevalence_by_flag": {"A01_vstop_flip_up": 0.0}},
  "t4": {"k": null, "selected": []},
  "checks": [{"id": "I1", "status": "PASS", "detail": "…"}],
  "caveats": ["<copy of src/data/adapter.py KNOWN_CAVEATS>"],
  "csv_sha256": "…"
}
```

### 6.3 `flags_<wk>_graded.csv` (written once, separate file — the record CSV is never mutated)

Record columns plus: `EP_actual, week_open, week_high, week_low, week_close, exit_reason, exit_price,`
`fwd_ret_oc_net_pct` (next-week open→close, minus round-trip cost, no stop — defined for every row),
`fwd_ret_control_exit_net_pct` (via `_grade_rows`: gap-stop-aware; uptrend rows use `vstop_line` as SL, others fall back to week close),
`fwd_excess_vs_eligible_pct` (row `fwd_ret_oc_net_pct` minus that week's equal-weight eligible mean — removes market beta; this is the primary target for flag analysis),
`fwd_excess_vs_benchmark_pct`, `graded_utc`, `missing_forward_bar` (1/0).
Plus `flags_<wk>_graded.summary.json`: eligible mean, benchmark week, T4 basket net (equal weight, Control exit rule), Control basket net copied from `picks_<wk>.json` if graded, counts by `flags_met` bucket.

### 6.4 `flag_ledger.csv` (append-only, long history)

Two append-only ledgers, both wide, keyed by `(registry_version, recording_mode, signal_week, ticker)`:
- `flag_ledger_records.csv` — appended at record: identity + all flags + `flags_met` + diagnostics.
- `flag_ledger_grades.csv` — appended at grade: key + all forward-return columns from §6.3.

Join on the key for analysis. Never update a ledger row in place; appending a duplicate key MUST raise.

### 6.5 `scorecard_<run_date>.csv` + `scorecard_latest.md`

Computed separately for `mode ∈ {forward, replay}` (never pooled; `late_backfill` reported on its own line, excluded from gate stats), per registry version.

Per flag:
- `n_weeks`, `mean_prevalence`
- weekly lift series `L_w = mean(excess | flag=1) − mean(excess | flag=0)` (skip week if either side has < 3 names) → `lift_mean, lift_ci_lo, lift_ci_hi` using `src/backtest/harness.py:bootstrap_ci` (seed 42, 5000) **over weeks, not rows** (rows within a week are correlated)
- `hit_rate_flag1, hit_rate_flag0` (share with `fwd_ret_oc_net_pct > 0`)
- `p_value` (bootstrap two-sided), `bh_q_value` (Benjamini–Hochberg across the 13 flags), `significant_after_bh`
- `maturity`: `<13 weeks: TOO_EARLY — do not read` · `13–25: FIRST_LOOK` · `≥26: REAL_READ` (constants imported from `tests/track_forward.py`)

For `flags_met`: weekly Spearman rank-IC vs `fwd_excess_vs_eligible_pct` → mean IC, bootstrap CI over weeks; bucket table (`0–3, 4–6, 7–9, 10–13`) with mean excess, hit rate, n.
Also: flag-to-flag correlation matrix (phi coefficients), and T4 vs Control paired weekly series (§7.4).

### 6.6 `run_log.jsonl` (append-only) and `run_status_latest.md` (overwritten)

`run_log.jsonl`: one JSON line per run: `run_id, trigger (selection_run|manual_replay|verify), picks_record_id, picks_created_utc, started/ended (IST), as_of, mode, stages[{name,status,seconds,detail}], checks summary, files_written, error`.
`run_status_latest.md`: human summary Dharmin reads on phone — as_of, mode, PASS/FAIL, eligible count, top 15 by `flags_met`, T4 picks, last graded week result, scorecard maturity line, caveat line.

---

## 7. T4 Test arm — registration (copy into plan doc §3.9 before any replay)

| field | value |
|---|---|
| **id** | T4 — Flag-count selection |
| **Mechanism (only this changes)** | Weekly shadow basket = eligible stocks with `A02=1` AND `A04=1` AND `flags_met ≥ K`, top `max_names=10` by tie-break order, equal weight, EP = next-week open, SL = `vstop_line`, Control's gap-stop-aware 1-week exit, 0.5% round trip. |
| **Identical to Control** | Universe/base gate, VStop/RSI definitions, risk cap (A04 is a hard requirement), exit rule, costs. |
| **Different from Control (acknowledged)** | Does **not** require a flip or RSI band — it is a selection change, closer to the V-series than T1–T3 (plan §3.6, HARNESS §9). Registered as a Test arm by Dharmin's explicit decision (15 Sep 2026); it never touches Control's picks or capital. |
| **Hypothesis** | Stocks meeting more registered conditions earn higher 1-week excess return than the eligible universe and than Control's basket. |
| **Kill criteria** | (a) VALIDATE replay (§7.3) mean weekly net ≤ 0 → retire before forward start. (b) At 26 forward weeks, paired T4−Control CI includes or is below zero → stays shadow/retired. (c) `flags_met` rank-IC CI at 26 forward weeks includes zero → matrix is not an ordering signal; T4 retired. |
| **Graduation** | At `REAL_READ_WEEKS = 26` **forward-mode** weeks only: T4 mean weekly net > 0 AND paired weekly `T4 − Control` bootstrap CI lower bound > 0. One decision, no second look (plan §3.5.4). `FIRST_LOOK_WEEKS = 13` is informational only. |

### 7.1 Weekly comparison rules

- A week with zero T4 names or zero Control trades counts as **0.0% return for that arm** — never dropped (avoid inheriting HARNESS §7 "flat weeks dropped" defect).
- Pair by `signal_week`, never by array position.
- Only `forward` records count toward §7 gates. `late_backfill` and `replay` never do.

### 7.2 Why A02 + A04 are hard requirements

Without an uptrend and a valid ≤15% stop, there is no Control-comparable SL and the exit rule is undefined. This keeps T4 inside Control's risk envelope.

### 7.3 Choosing K (one-time, pre-registered protocol)

1. Run `replay` for the most recent 104 completed weeks before the first forward week (`scripts/common.py:trading_fridays` calendar, PIT-sliced).
2. **DEV** = older 52 weeks. For each K in `k_grid`, compute weekly T4 net. Pick the K with the highest mean weekly net among K values that produce ≥ 1 name in ≥ 60% of weeks. Ties → larger K.
3. **VALIDATE** = newer 52 weeks. Run the chosen K **once**. Record result in `docs/forward_test_findings.md`.
4. If kill criterion (a) is not hit → write K into `config/feature_flags.yaml`, bump to `registry_version: 1` lock (`track_flags registry-lock`), commit. K is then frozen.
5. Caveat to record alongside: this 104-week window overlaps the window already used by Control's walk-forward (plan §6 open decision 4) and carries survivorship bias (`KNOWN_CAVEATS`). Replay results are dev evidence, not proof.

### 7.4 Paired series in scorecard

`t4_vs_control.csv`: `signal_week, mode, t4_n, t4_net_pct, control_n, control_net_pct, delta_pct, eligible_mean_pct, benchmark_pct`.

---

## 8. Procedures

### 8.1 First run — last week (signal week 2026-09-07)

Now is Tue 15 Sep 2026; the holding week opened Mon 14 Sep 09:15 IST. This record is **`late_backfill`** — useful evidence, excluded from T4 gates. Say so in the output; do not present it as a forward test (HARNESS §5).

1. Implement Phase 1 (§12) and pass tests.
2. `python -m tests.track_flags record --as-of 2026-09-07` → mode auto-resolves to `late_backfill`.
3. `python -m tests.track_flags verify 2026-09-07`. Expected (acceptance):
   - `rows == 264` (= `picks_2026-09-07.json` funnel `liquidity_filter`).
   - Tickers with `A01=1 AND A03=1` == `{JUBLPHARMA.NS, PINELABS.NS, SPLPETRO.NS}` (Control survivors).
   - Tickers with `A01=1 AND A03=1 AND A04=1` == `{JUBLPHARMA.NS, SPLPETRO.NS}` (Control TRADEs).
   - Any mismatch = divergence bug; stop and report, do not "adjust" flags to match.
4. After Fri 18 Sep 2026 close, refresh data and `grade results/feature_flags/flags_2026-09-07.csv`.
5. Run §7.3 replay + K protocol (can run in parallel with step 4 — replay does not need the 14 Sep bar).
6. First **forward** record: signal week 2026-09-14. It is produced automatically when Dharmin runs that week's stock selection (`scripts/weekly_selection_run.sh`) after the Fri 18 Sep close and before Mon 21 Sep 09:15 IST.

For this first run, `picks_2026-09-07.json` already exists, so use `python -m tests.track_flags on-selection --picks results/forward_test/picks_2026-09-07.json`. Mode resolves to `late_backfill` because the flag record is created after the Monday open.

### 8.2 Weekly procedure (triggered by stock selection)

Whenever Dharmin selects stocks for the week, he runs one command, `scripts/weekly_selection_run.sh`, or asks Claude Code to "run the weekly forward test". Either way the order is fixed:

1. Grade last week: `track_forward grade` (Control) → `track_forward t1grade` → `track_flags grade --all-pending` (flag matrix + T4).
2. Select this week: `track_forward record` (Control picks) → `track_forward t1`.
3. **Flag trigger:** `track_flags on-selection --picks results/forward_test/picks_<wk>.json`, which runs stages 0–6 for that exact `as_of`.
4. Audit: `flag-run-auditor` agent (stage 7).
5. Review: Dharmin reads `run_status_latest.md` next to the Control picks before placing trades.

Pairing rules:
- **No selection run means no flag record.** The flag pipeline never runs by itself on a clock.
- **Control record refused** (the picks file already exists): step 3 still runs if `flags_<wk>.csv` is missing. It exits as `skipped_already_done` if the flags file is already there.
- **Control record failed:** the script stops before step 3.
- **Timing:** the pre-open rule is judged by the flag record's own `created_utc`. If the selection run happens after Monday 09:15 IST, both records are late. The flag record is labelled `late_backfill`.

### 8.3 Replay procedure

`python -m tests.track_flags replay --start YYYY-MM-DD --end YYYY-MM-DD` → writes `replay/flags_<wk>.csv` + manifests + grades in one pass (future bars exist). Replay MUST call the same `build_flag_matrix()` with an explicit `as_of`; the leakage test (T-06) covers it. Replay files may be regenerated (they are not forward evidence) but only into `replay/`, and each regeneration writes a new `replay_run_id` in the manifest.

### 8.4 Adding, changing, or retiring a flag

1. Propose in `docs/forward_test_findings.md` (new dated entry) with rationale **before** looking at its forward performance.
2. Edit `config/feature_flags.yaml`, bump `registry_version`, run `registry-lock`.
3. Old records keep their version; scorecards split by version; T4 K must be re-derived via §7.3 for a new version (new arm id `T4v2`), never carried over.
4. Retiring a flag = set `countable: false` in a new version. Never delete history.
5. Never change a threshold because a scorecard looked bad/good for < 26 weeks (HARNESS §10).

### 8.5 When a check fails

Keep all written files, mark run `FAILED` in `run_log.jsonl`, write the failing invariants into `run_status_latest.md`, exit non-zero. Do not delete or rewrite the record. If the record itself is wrong, append a findings entry and record the next week correctly — same immutability rule as `picks_*.json`.

---

## 9. Guardrails and invariants

### 9.1 Guardrails (MUST)

| # | Guardrail | Enforced by |
|---|---|---|
| G1 | Control files and selection untouched (`rules.yaml`, `run_screen` default output, `build_trades`). | T-04, git diff check in auditor |
| G2 | One screening path: eligible set comes only from `run_screen(include_eligible_features=True)`. | T-05 |
| G3 | Point-in-time: every panel `_slice_as_of`-sliced before any feature; benchmark too. | T-06 |
| G4 | Refuse to record a week that has not closed (`now_ist < as_of + 5 days 00:00 IST`) — no partial weekly bars. **Also** assert the as_of bar is the week requested, not `all_dates(panels)[-1]` blindly. | T-08 |
| G5 | Mode is derived, never passed as `forward` by a user when the deadline has passed. | T-07 |
| G6 | Immutable records: `flags_<wk>.csv` / manifest refuse overwrite; grades go to separate files; ledgers append-only with dedupe. | T-09, T-13 |
| G7 | Missing ≠ false: unevaluable flags are blank and excluded from `flags_evaluable`. | T-03 |
| G8 | Registry changes require version bump + checksum. | T-01 |
| G9 | Statistics clustered by week; maturity labels printed; BH correction shown; no verdict before 13/26 weeks. | T-12 |
| G10 | Flat weeks count as 0% for any basket. | T-11 |
| G11 | Hermetic tests: no network; use `tests/offline.py`. | existing HARNESS §8 |
| G12 | Every output carries `KNOWN_CAVEATS`. | T-10 |
| G13 | The LLM agent never computes, edits, or deletes numbers or records; only reads, runs whitelisted commands, and appends prose to findings. | agent tool allowlist (§11.3) |
| G14 | No real capital for T4 before §7 graduation. `run_status_latest.md` labels T4 picks "SHADOW — not for trading". | T-10 |

### 9.2 Invariants checked every run (`src/flags/checks.py`)

- **I1** `rows == funnel.liquidity_filter`.
- **I2** `{A01=1 ∧ A03=1}` == Control survivors from the same `run_screen` call (and == `picks_<wk>.json` survivors if that file exists).
- **I3** `{A01 ∧ A03 ∧ A04}` == `build_trades()` tickers for that as_of.
- **I4** `flags_met` recomputed from columns equals stored; `0 ≤ flags_met ≤ flags_evaluable ≤ n_countable`.
- **I5** All flag cells ∈ {`0`,`1`,empty}.
- **I6** Nested logic holds: `C01=1 ⇒ A04=1 ⇒ A02=1`; `B05=1 ⇒ A02=1`; `B02=1 ⇒ B01=1`.
- **I7** Manifest `registry_checksum` equals current registry; `rules_yaml_sha256` equals the value in the previous record (warn, not fail, if changed — and surface loudly).
- **I8** No input bar dated after `as_of` Friday used (max date in sliced panels ≤ as_of).
- **I9** Data freshness: cache `fetched_at` later than as_of Friday 15:30 IST.
- **I10** Determinism: re-running `build_flag_matrix` in memory yields an identical frame (excluding timestamps).

---

## 10. Test suite (hermetic, pytest)

| id | file | asserts |
|---|---|---|
| T-01 | `test_flags_registry.py` | schema valid; ids unique; 13 countable; checksum mismatch after edit without version bump fails. |
| T-02 | `test_flags_rules.py` | each rule on synthetic rows incl. boundary values (RSI exactly 50/65, ratio exactly 1.5, headroom exactly 5.0) and downtrend → 0 cases. |
| T-03 | `test_flags_matrix_counts.py` | NaN inputs → blank, excluded from evaluable; `flags_met` math. |
| T-04 | `test_run_screen_eligible_features.py` | `run_screen` return dict identical for every pre-existing key with flag on/off (use `pd.testing.assert_frame_equal`); `eligible_features` row count == `liquidity_filter`. |
| T-05 | `test_flags_match_control.py` | on offline env for last cached week: I2 and I3 hold. |
| T-06 | `test_flags_leakage.py` | reuse `_corrupt_after`/`_truncate_after` from `test_leakage.py`: corrupting bars after as_of leaves matrix unchanged. |
| T-07 | `test_flags_timing.py` | frozen clocks: Sat 19 Sep 10:00 IST → forward; Mon 21 Sep 09:16 IST → late_backfill; IST/UTC conversion. |
| T-08 | `test_flags_partial_week.py` | Wed-of-week clock with a Monday-dated current bar → record refuses. |
| T-09 | `test_flags_immutable.py` | second record for same week refuses; grade doesn't modify record CSV bytes. |
| T-10 | `test_flags_outputs.py` | column order, manifest keys, caveats present, T4 shadow label. |
| T-11 | `test_t4_selection.py` | deterministic tie-break; A02/A04 hard requirement; zero-pick week → 0.0 in paired series. |
| T-12 | `test_flags_scorecard.py` | week-clustered bootstrap on synthetic data with known lift; BH ordering; maturity labels at 12/13/25/26 weeks. |
| T-13 | `test_flags_ledger.py` | append + duplicate-key raise. |
| T-14 | `test_flags_audit_determinism.py` | two `audit` runs on the same fixture give byte-identical JSON; reasons are all in the closed set. |
| T-15 | `test_flags_findings.py` | `findings-draft` matches a golden file; `findings-append` exits 0 then 4; exactly one entry is appended; a not-noteworthy fixture exits 3 and writes nothing. |
| T-16 | `test_flags_audit_detects.py` | a tampered CSV fails AU04; a wrong mode label fails AU02; `rules.yaml` drift fails AU03; mismatched picks week fails AU05. |

Also re-run existing `tests/test_leakage.py`, `tests/test_screen_funnel.py`, `tests/test_backtest_engine.py` — must stay green.

---

## 11. Tools, skill, agent, trigger

### 11.1 CLI — `python -m tests.track_flags <cmd>`

| cmd | does |
|---|---|
| `preflight [--as-of auto|DATE]` | Stage 0 only; prints resolved as_of, mode, deadline, blockers. Exit 0/1. |
| `refresh` | Stage 1 via `scripts/common.py:bootstrap` (OpenSourceAdapter); asserts I9. |
| `record --as-of DATE|auto` | Stages 3–5 for one week. |
| `grade PATH | --all-pending` | Stage 2. |
| `replay --start DATE --end DATE` | §8.3. |
| `t4-calibrate` | §7.3 DEV/VALIDATE; prints result; does NOT write K (Dharmin/agent writes after reviewing, via `registry-lock --t4-k N`). |
| `registry-lock [--t4-k N]` | Writes checksum (and K once). Refuses to change an already-set K within a version. |
| `scorecard [--mode forward|replay|all]` | §6.5. |
| `verify DATE` | I1–I10 on an existing record. |
| `on-selection --picks PATH` | **The trigger command.** Reads `as_of` from the picks file and runs stages 0–6 in order, with lockfile `results/feature_flags/.run.lock`. Called only by `scripts/weekly_selection_run.sh` or the `weekly-forward-test` skill. |
| `status` | Prints `run_status_latest.md`. |
| `audit --as-of WK --json|--format md` | §11.3.1 audit tool. Exit 0 PASS / 10 FAIL / 20 error. |
| `findings-draft --as-of WK` | §11.3.1 template render. |
| `findings-append --as-of WK` | §11.3.1 idempotent, noteworthy-gated append. Exit 0 / 3 / 4 / 20. |

### 11.2 Skill — `.claude/skills/weekly-flag-matrix/SKILL.md`

Frontmatter: `name: weekly-flag-matrix`, `description: Run, audit, or explain the weekly feature-flag condition matrix and T4 shadow arm (tests/track_flags.py) — pre-open recording, immutability, and week-clustered statistics apply.`
Body: the §8.2 procedure. Treat this skill as the tail of `weekly-forward-test`, not a standalone schedule. Timing check first; never re-record; after `on-selection`, invoke `flag-run-auditor` with the week. The agent follows its fixed decision table; whether a findings entry is appended is decided by `findings-append`'s code, not by the session. Then hand off to `rebuild-test-control-dashboard`. Link HARNESS + this spec rather than restating rules.

### 11.3 Agent — `.claude/agents/flag-run-auditor.md` (deterministic, tool-driven)

**Design principle:** the agent makes no decisions. Every check, every "is this noteworthy?" call and every word of the findings entry comes from deterministic Python tools with fixed JSON schemas and exit codes. Given the same files, the tools produce byte-identical output. The agent does three things only:
1. Calls the tools in a fixed order.
2. Branches on exit codes using the decision table below.
3. Relays the tools' own rendered text verbatim.

If the agent were removed, the pipeline would still produce the same audit and findings. The agent is an operator, not an analyst.

#### 11.3.1 Audit tools (implement in `src/flags/audit.py` and `src/flags/findings.py`)

| tool (CLI) | input | output | exit codes |
|---|---|---|---|
| `track_flags audit --as-of WK --json` | record, manifest, graded files, ledgers, scorecard, git | `results/feature_flags/audit/audit_<wk>.json` (schema below), also printed to stdout | `0` all PASS · `10` ≥1 FAIL · `20` tool error (missing file, bad schema) |
| `track_flags audit --as-of WK --format md` | `audit_<wk>.json` only | fixed-layout markdown table: check id, status, expected, actual | `0` / `20` |
| `track_flags findings-draft --as-of WK` | `audit_<wk>.json` + scorecard + graded summary | `results/feature_flags/audit/findings_<wk>.md`, rendered from `src/flags/templates/findings_entry.md.tmpl` (`string.Template`, no free text) | `0` / `20` |
| `track_flags findings-append --as-of WK` | `findings_<wk>.md` + `audit_<wk>.json` | appends to `docs/forward_test_findings.md` **only if** `noteworthy.any == true`. It first writes the idempotency marker `<!-- flags-audit:<wk>:<sha256 of draft> -->` and refuses if that marker already exists. | `0` appended · `3` not noteworthy (nothing written) · `4` already appended · `20` error |

**Audit checks (fixed list, fixed order; each returns `{id, status: PASS|FAIL|WARN, expected, actual}`):**

| id | check | how (deterministic) |
|---|---|---|
| AU01 | Invariants I1–I10 | call `src/flags/checks.py` on the record |
| AU02 | Mode label correct | recompute `forward`/`late_backfill` from manifest `created_utc` vs holding-week Monday 09:15 IST; compare to stored label |
| AU03 | Control frozen | sha256 of `config/rules.yaml`, `src/screen/engine.py`, `src/trade/builder.py` vs the previous manifest. Also `git diff --quiet HEAD -- config/rules.yaml src/trade/builder.py`. An engine.py hash change is WARN unless T-04 passes in the same run, in which case PASS. |
| AU04 | Record immutable | `csv_sha256` in manifest == sha256 of `flags_<wk>.csv`. `git status --porcelain -- results/forward_test results/feature_flags` shows no `M`/`D` on any existing `picks_*` or `flags_*` file. |
| AU05 | Picks ↔ flags pairing | `picks_<wk>.json.signal_week_start == manifest.signal_week`; I2/I3 ticker sets equal |
| AU06 | Caveats present | manifest `caveats` == `KNOWN_CAVEATS`; `run_status_latest.md` contains the caveat line |
| AU07 | T4 shadow label | `run_status_latest.md` contains the literal `SHADOW — not for trading` when T4 picks exist |
| AU08 | Ledger integrity | no duplicate keys; record-ledger row count for the week == CSV rows |
| AU09 | Grade integrity | for each graded week: `EP_actual` == next bar open from cache; gap-stop rows have `exit_price == EP_actual` |
| AU10 | Run log | last `run_log.jsonl` line for the week has all stages `done` or `skipped_already_done` |

**`audit_<wk>.json` schema (versioned; keys sorted; floats rounded to 3 dp):**

```json
{
  "audit_schema_version": 1,
  "as_of": "2026-09-07",
  "recording_mode": "late_backfill",
  "overall": "PASS",
  "checks": [{"id": "AU01", "status": "PASS", "expected": "...", "actual": "..."}],
  "facts": {
    "eligible_count": 264, "flags_met_histogram": {"0": 0},
    "t4_picks": [], "control_trades": ["JUBLPHARMA.NS", "SPLPETRO.NS"],
    "forward_weeks_graded": 0, "maturity": "TOO_EARLY",
    "last_graded": {"signal_week": null, "eligible_mean_pct": null, "control_net_pct": null,
                    "t4_net_pct": null, "benchmark_pct": null}
  },
  "noteworthy": {
    "any": true,
    "reasons": ["recording_mode_late_backfill"]
  },
  "inputs_sha256": {"flags_csv": "...", "manifest": "...", "scorecard": "..."}
}
```

**`noteworthy.reasons` is a closed set, computed by code, never by the agent:**
`check_failed` · `check_warn` · `recording_mode_late_backfill` · `first_record_for_registry_version` · `forward_weeks_reached_13` · `forward_weeks_reached_26` · `flag_bh_significance_changed` (vs previous scorecard) · `t4_k_locked_this_run` · `t4_zero_picks_4_consecutive_weeks` · `eligible_count_changed_gt_10pct` (vs previous week). Adding a reason means bumping `audit_schema_version`.

#### 11.3.2 Agent file

```markdown
---
name: flag-run-auditor
description: Deterministic operator for the post-selection flag audit. Runs the audit tools in a fixed order and relays their output verbatim. Never computes, interprets, or edits.
tools: Bash
---
You are an operator. You do not analyse, summarise, or judge. Tools decide; you relay.

Input: the week WK (YYYY-MM-DD) given in the invoking prompt.

Run exactly these commands, in this order, and nothing else:
  1. python -m tests.track_flags audit --as-of WK --json
  2. python -m tests.track_flags audit --as-of WK --format md
  3. python -m tests.track_flags findings-draft --as-of WK
  4. python -m tests.track_flags findings-append --as-of WK

Decision table (branch only on exit codes):
  step 1 exit 20            -> print "AUDIT TOOL ERROR" + stderr verbatim; stop.
  step 1 exit 0 or 10       -> continue to step 2 (a FAIL is still reported and logged).
  step 2 exit 20            -> print "AUDIT RENDER ERROR" + stderr verbatim; stop.
  step 3 exit 20            -> print "FINDINGS RENDER ERROR" + stderr verbatim; stop.
  step 4 exit 0 / 3 / 4     -> continue.   exit 20 -> print "FINDINGS APPEND ERROR"; stop.

Final output, exactly this layout:
  Line 1: "FLAG AUDIT <WK>: <overall from step 1 JSON>"
  Then:   stdout of step 2, verbatim.
  Then:   "Findings: appended" | "Findings: not noteworthy" | "Findings: already appended"
          (from step 4 exit code 0 / 3 / 4).

Never: read CSV/JSON files directly, re-run record/grade/on-selection, edit any file,
add commentary, round or restate numbers, or give a trading opinion.
```

**Permissions.** The agent gets `Bash` restricted to the four commands above. In the headless call (§11.4) this is enforced with `--allowedTools`. It has no `Read`, `Edit` or `Write`, so it has nothing to improvise with.

**Determinism tests:** T-14, T-15 and T-16 in §10.

### 11.4 Trigger — the weekly stock-selection run

The flag matrix is a **chained step of the run that picks stocks for trading**. There is no separate cron, launchd job or scheduled task for it. Reasons:
- The flag matrix and the trade picks always share one `as_of`, one data snapshot and one timestamp, so invariant I2 compares like with like.
- A skipped selection week can't leave an orphan flag record, and a selection run can't happen without its flag record.
- There is one thing to remember each week, not two.

`scripts/weekly_selection_run.sh`:

```bash
#!/usr/bin/env bash
# Weekly stock-selection run. Control selection first, flag matrix chained after it.
set -euo pipefail
cd "$(dirname "$0")/.."
source .venv/bin/activate

# 0. Refuse to select on a partial week (newest bar must belong to a closed week — G4, §14)
python -m tests.track_flags preflight --as-of auto

# 1. Grade last week (each step is idempotent / short-circuits if already graded)
for f in results/forward_test/picks_*.json; do
  case "$f" in *_t1.json) python -m tests.track_forward t1grade "$f" || true ;;
               *)         python -m tests.track_forward grade   "$f" || true ;; esac
done
python -m tests.track_flags grade --all-pending || true

# 2. Select this week (Control + T1). record() refuses to overwrite — that is fine.
python -m tests.track_forward record
python -m tests.track_forward t1 || true

# 3. FLAG TRIGGER — same week as the picks file just written/found
PICKS=$(ls -1 results/forward_test/picks_*.json | grep -v '_t1\.json$' | sort | tail -1)
STATUS=0
python -m tests.track_flags on-selection --picks "$PICKS" || STATUS=$?

# 4. Audit (read-only agent); never blocks the selection output
WK=$(python -c "import json,sys;print(json.load(open(sys.argv[1]))['signal_week_start'])" "$PICKS")
claude -p "Invoke the flag-run-auditor agent for WK=$WK. Follow its decision table exactly." \
  --allowedTools "Bash(python -m tests.track_flags audit:*),Bash(python -m tests.track_flags findings-draft:*),Bash(python -m tests.track_flags findings-append:*)" \
  >> results/feature_flags/claude_audit.log 2>&1 \
  || python -m tests.track_flags audit --as-of "$WK" --format md >> results/feature_flags/claude_audit.log 2>&1 || true
# The fallback line runs the same deterministic tool if Claude is unavailable, so the audit never depends on the LLM.
exit $STATUS
```

Notes for implementation:
- **Picks file:** step 3 must use the picks file for the week `record` just resolved. Pick the newest non-T1 `picks_*.json` **and** assert its `signal_week_start` equals the latest closed week (G4). If it doesn't match, exit non-zero rather than flagging a stale week.
- **Partial-week guard:** step 0's `preflight` is mandatory. The chain inherits `track_forward record`'s `as_of = all_dates(panels)[-1]` (§14), so the script must stop before selection if the newest bar belongs to a week that hasn't closed yet.
- **How it gets started:**
  - Manually: Dharmin runs `scripts/weekly_selection_run.sh`.
  - Through Claude Code: asking to "run the weekly forward test" (the `weekly-forward-test` skill executes the same sequence).
  - Scheduling, if ever wanted, wraps the whole script as one job so selection and flags stay a single unit. Never schedule `track_flags` alone.

---

## 12. Implementation phases and acceptance

| Phase | Scope | Done when |
|---|---|---|
| **P1 — Matrix core** | registry, rules, `run_screen` kwarg, matrix, timing, checks, `record`/`verify`/`preflight`, T-01…T-10 | §8.1 steps 2–3 pass on real cache for 2026-09-07 (264 rows, I2/I3 match). |
| **P2 — Grading + ledger** | grade, ledgers, `grade`/`refresh`, T-13 | 2026-09-07 graded after 18 Sep close; ledger rows == 264. |
| **P3 — Replay + scorecard** | replay, scorecard, T-12 | 104 replay weeks written; `scorecard --mode replay` produces per-flag table with CIs and maturity labels. |
| **P4 — T4** | plan-doc §3.9 registration committed **first**, t4 selection, `t4-calibrate`, paired series, T-11 | DEV/VALIDATE result logged in findings; K locked or T4 retired. |
| **P5 — Automation** | `on-selection`, lockfile, run log/status, audit tools (`audit`, `findings-draft`, `findings-append`) + T-14…T-16, skill, deterministic agent, `scripts/weekly_selection_run.sh`, `weekly-forward-test` skill update, CLAUDE.md + dashboard skill updates | Dry run with a frozen clock produces full stage log. `scripts/weekly_selection_run.sh` run end to end writes `picks_<wk>.json` and `flags_<wk>.csv` with the same `signal_week`. `on-selection` without a picks file exits 3. |
| **P6 (later)** | Registry v2 Family E indicators | Separate task after ≥ 13 forward weeks of v1. |

Commit after each phase (attribution per repo convention). Do not commit `data_cache/`.

---

## 13. Decisions (defaults applied unless Dharmin overrides here)

| id | decision | default |
|---|---|---|
| D1 | T4 universe: full eligible set (selection change, acknowledged) vs. restrict to Control survivors + near-misses (too few names to be useful). | **Full eligible set** — Dharmin chose "become a Test arm" on 15 Sep 2026. |
| D2 | Additive `include_eligible_features` kwarg on `run_screen()`. | **Approve** — the only way to avoid a parallel funnel. |
| D3 | Version-control `results/feature_flags/` (and consider un-ignoring `.claude/`, currently gitignored so skills aren't committed). | **Yes** for `results/feature_flags/`; flag `.claude/` to Dharmin, don't change it silently. |
| D4 | v1 thresholds (B04 1.5×, B05 2.0 ATR, C-family from `candidate_score.py`). | **Accept as a-priori**; lock before first record. |
| D5 | When to start Family E. | After 13 forward weeks of v1. |
| D6 | Trigger. | **Decided 15 Sep 2026 by Dharmin:** chained to the weekly stock-selection run (`scripts/weekly_selection_run.sh` / `weekly-forward-test` skill). No independent schedule. |
| D7 | Fundamental valuation flags (P/E, P/B, EV/EBITDA, ROE, D/E). | **Out of scope** until a point-in-time fundamentals source is chosen (would be Family F, new version). |

## 14. Known issue to log, not fix quietly

`tests/track_forward.py:record()` and `record_t1_shadow()` take `as_of = all_dates(panels)[-1]`. If the cache is refreshed mid-week, yfinance's Monday-dated in-progress bar becomes `as_of` — a partial-week signal. The flag pipeline avoids this via G4. For Control, append a findings entry describing the risk and let Dharmin decide on a fix (HARNESS §7 spirit: don't change Control's cadence mid-task).

## 15. Out of scope

Live order placement; broker integration; position sizing beyond T4 equal-weight shadow; changing Control; intraday/daily flags (T1 territory); fundamentals.
