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
