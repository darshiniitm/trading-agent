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
