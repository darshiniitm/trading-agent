
# Forward-Test Response & Trade-Volume Plan

*Version 0.7 — 2026-09-13. Follows `docs/forward_test_findings.md` (repo), `claude/forward-test-log.md`, `claude/vstop-strategy-revision-plan.md`, and `claude/selection-and-analysis-improvement-plan.md`. Scope: (1) what the first graded forward-test week actually tells us and doesn't, (2) a **Test-vs-Control** design for raising trade count and gain *inside* the existing universe, VStop parameters, RSI band and risk cap — no condition in the strategy spec changes, and no per-trade or portfolio risk goes up, and nothing gets adopted until it beats Control on logged evidence. (3) §3.7 — what T1's first live week says and how T1 specifically gets refined, with Control untouched throughout. (4) §3.8 — the T1 candidate-score parameter list, reorganized into edge signal / risk guardrail / instrumentation-pending buckets, with a scoring-architecture decision (gate vs. blend) still open.*

*Companion: `test-vs-control-ledger.html` (published as an artifact) renders every week in this section visually and is rebuilt after each grade.*

---

## 0. What just happened

Record `fwd_2026-08-24` graded on 2026-09-06:

| | |
|---|---|
| Basket (1 trade: ENGINERSIN) | **+9.74% net** |
| Prior expectation (104-week walk-forward) | −1.81% |
| Benchmark (Nifty Midcap 150) that week | −1.31% |
| Shadow (NSLNISP, rejected by 15% risk cap) | −4.97% |
| Near-miss (IFCI, RSI 67.9 — filtered by the band) | +12.77% (not traded) |

Read literally, every name that flipped VStop that week made money or beat the benchmark, and the risk cap correctly kept the basket out of the one loser.

**This changes nothing about the strategy, and the standing rules already say why.** One trade is not a sample — the 104-week study put the standard deviation of a single mid-cap week at 5–6%, against a −1.4% expected edge; +9.74% is well inside what a broken strategy produces by chance one week in several. The pre-registered prior explicitly forbids updating on this. What it *does* do is validate that the near-miss tracking built into `run_screen()` after the RSI-ceiling observation is working exactly as designed, and it hands us two live hypotheses to register for later, not to act on now.

---

## 1. Two problems, kept separate (as the existing plan requires)

| | Question | Where it's answered |
|---|---|---|
| **Response to this finding** | Does the IFCI/RSI-ceiling observation or the risk-cap result change anything today | §2 — no, not yet; here's what accumulating it looks like |
| **Trade volume** | How to get more trades per week, and more out of the ones taken, without loosening or widening any condition already in the strategy spec | §3 — as a Test-vs-Control design |

---

## 2. Responding to the forward-test finding without breaking discipline

The finding is real but it is `n=1`. The correct response is the one `docs/forward_test_findings.md` already names: accumulate.

- **RSI ceiling (65):** IFCI is the first data point in what will become the `near_miss` population (`graded.near_miss_basket_net_pct`, per ticket already shipped in `run_screen()`). Nothing changes until this population is large enough to bootstrap a confidence interval — the same bar the strategy's own headline numbers were held to (CI95 excluding zero). Rough rule of thumb from the existing project: treat ~13 weeks as a first look, ~26 as a real read, matching the cadence already set for the forward-test log itself (Part C of the improvement plan).
- **15% risk cap:** this week is a point *in favor* of the cap (it kept the basket out of the −4.97% shadow). That's one data point too, and it cuts the other way from the RSI observation — a reminder that the two "near miss" questions are independent and should be graded independently, not bundled into a single "loosen the filters" narrative.

**Concrete action:** no code or parameter change. Just keep grading. Add both series (RSI near-miss basket returns, shadow/risk-cap basket returns) to the standard diagnostic pack (§A2 of the improvement plan) so they show up automatically on every future grade rather than requiring a manual look back at this document.

**Second week (`fwd_2026-08-31`), graded 2026-09-13:** Control basket +1.66% (1 trade, LICHSGFIN). Shadow (2 risk-cap rejects) +1.94% net, split +14.51% / −10.64% — another reminder the cap's two rejects can land on either side of the line in a given week. Near-miss (CGCL, RSI 74.5) −6.41% — this time the ceiling's reject *would* have lost money, the opposite of week one's IFCI. Two weeks now point in opposite directions on the RSI-ceiling question, which is exactly why §2's rule stands: accumulate, don't react.

---

## 3. Test vs Control: raising trade count and gain without touching the spec

**Ground rule for everything below:** the universe (₹10–50k cr cap band), the liquidity floor, VStop(10,2), RSI(14) in [50,65], and the flat 15% risk cap are the conditions you specified — they don't move in this plan. Every Test arm evaluates the *same* rule against more opportunities to satisfy it, or changes how capital is deployed across trades that already pass the *same* rule unchanged. Nothing here is adopted on judgment — each arm runs as a shadow against Control, on the same weeks, and only replaces Control if it clears a pre-registered gate.

### 3.1 Control — defined once, frozen

**Control is the current production code, unchanged, exactly as it produced `fwd_2026-08-24` and `fwd_2026-08-31`:**

- Weekly funnel anchored to the Mon–Fri calendar week, signal read from Friday's close only.
- Universe, liquidity floor, VStop(10,2), RSI[50,65], 15% risk cap — as specified.
- Equal-weight sizing across whatever survives the funnel that week.
- A rejected name (risk-cap shadow) is dropped for that week only; re-screened fresh next week.

Control keeps running exactly as today, keeps taking the real capital, and keeps being logged in `forward-test-log.md` the same way. It is the baseline every Test arm is measured against — not a strategy variant, a fixed reference point. **Nothing in §3.7 below changes anything in this subsection.**

### 3.2 Test arms — each a separate registered experiment

Each arm changes exactly one mechanism, runs in **shadow mode** (computed and logged every week, no capital) alongside Control, and is graded against Control on the same weeks — the same discipline already used for the risk-cap shadow (NSLNISP) and the RSI near-miss (IFCI), just applied to volume/allocation questions instead of filter questions.

| Arm | Mechanism (only this changes) | What stays identical to Control | Hypothesis | Kill criterion |
|---|---|---|---|---|
| **T1 — Rolling window** | Same VStop(10,2)+RSI[50,65] rule evaluated on a rolling 5-trading-day window (or several weekly cycles offset by a day each), not only the Mon–Fri anchor | Universe, thresholds, risk cap, sizing | Catches genuine flips the Friday-only anchor misses, without changing what "a flip" means | Trades captured by T1-only vs Control-only show no better (or worse) per-trade return than Control's existing trades, at matched sample size |
| **T2 — Fixed-fractional sizing** | Re-weight the *same trade list Control produces* by 1% capital ÷ R per position, instead of equal weight | Trade selection identical to Control — this is an allocation replay, not a new signal | Portfolio-level return/vol improves on weeks with >1 survivor because risk is normalized instead of split evenly | No improvement in risk-adjusted (not raw) return vs Control on the same trade list |
| **T3 — Confidence-weighted allocation** | On weeks with >1 survivor, tilt capital toward the higher-confidence name(s) instead of equal split | Trade selection identical to Control | Confidence score (per B6's planned rank-IC test) is a real ordering signal, so tilting toward it beats equal weight | Rank-IC not significantly different from zero, or tilted allocation underperforms equal weight |
| **Housekeeping check** | Confirm a risk-cap-rejected name is never silently excluded from later weeks | N/A — verification, not an experiment | — | — |

**Why fixed-fractional (1% ÷ R) for T2, specifically.** This isn't picked for novelty — it's the direct fix for a defect the project has already diagnosed. `selection-and-analysis-improvement-plan.md` (B4) points out that under Control's equal weight, a 12-pick week and a 1-pick week carry the same *per-position* size, so total portfolio risk on any given week is really set by how many names happen to survive the funnel, not by design. Sizing each position at (risk budget) ÷ R makes the dollar risk per position constant regardless of survivor count — it's a normalization of the risk that's already implicit in Control, not an addition to it. It was chosen over the alternatives for concrete reasons:

- **R is already on every trade record** (`R_ref`, `R_pct_of_close` are computed fields today). Sizing off it needs no new estimate and can't introduce a new source of error.
- **Volatility/ATR-based sizing** is effectively the same idea already — R itself is derived from the VStop distance, which is ATR-based — so a separate ATR sizing scheme would be redundant with what R already encodes.
- **Kelly-style sizing** was not used because it needs a trusted edge/variance estimate to size off, and the strategy's own headline expectancy is currently negative (−1.37%/trade); sizing aggressively off an edge estimate that isn't yet established would be the opposite of risk-conscious here.
- **A flat rupee amount per trade** was rejected because it ignores stop distance entirely — a wide-stop name and a tight-stop name would carry very different risk for the same position size, which is the exact problem being fixed.
- **The "1%" figure is a placeholder**, not a derived number — the thing actually under test is the *method* (size by R) against Control's method (equal weight); the specific fraction is a parameter to set once the method itself is validated, not something this plan is claiming to have optimized.

T1 is the only arm that can actually add trade *count*; T2 and T3 improve what's extracted from trades Control already takes. All three can run simultaneously in shadow mode without interfering, since none of them touch what Control itself does.

### 3.3 How Test and Control run side by side

1. Every signal week, Control runs as today and its trades are the ones with real capital, logged exactly as now.
2. In the same run, T1's rolling-window scan is computed and logged as a shadow basket — same format as the existing risk-cap shadow — with its own funnel and its own picks.
3. T2 and T3 don't need a separate scan: they're re-weightings of Control's own trade list, logged as alternate basket returns for the same picks.
4. Nothing here changes what capital is deployed on. Test stays paper until §3.5 says otherwise.

### 3.4 Metrics compared, every graded week

- Trade count: Control vs T1 (the number this section exists to move).
- Basket net return: Control vs T1-shadow vs T2-reweighted vs T3-reweighted, same weeks.
- Per-trade expectancy and alpha vs eligible universe (the same diagnostic already used to judge Control itself in §2 of the improvement plan) computed separately for each arm.
- How many of T1's extra trades come from flips that would have reversed by Friday anyway (a legitimate concern to track, not just count raw volume as good) — live as of `fwd_2026-08-31`: `n_extra_confirmed: 17`, `n_extra_reversed: 4`.

### 3.5 When a Test arm is allowed to touch real capital

Same discipline as the strategy-level validation gates in `vstop-strategy-revision-plan.md` §6.2, scaled to this smaller question:

1. Register each arm before it starts running (id, hypothesis, kill criterion — the table in §3.2 *is* the registration; nothing else runs unregistered).
2. Development-set weeks first if there's history to replay it against; otherwise accumulate shadow weeks going forward — same ~13/~26-week cadence as §2.
3. An arm graduates from shadow to live only if its basket return beats Control's, on the same weeks, with a bootstrap CI that excludes zero — not merely "looked better one week."
4. One graduation decision per arm, not a running re-evaluation — if it doesn't clear the bar at the review point, it stays shadow (or is retired), it doesn't get a second look on cherry-picked weeks.
5. Graduating T2 or T3 changes *sizing*, not selection — lower bar for risk, since by construction they can't add a new losing trade Control wasn't already going to take.

**T1 is not at its review point yet — one live week (`fwd_2026-08-31`) is nowhere near ~13.** §3.7 below is about refining how T1 is instrumented between now and that review, not about judging it early.

### 3.6 What was deliberately left out of Test

Widening the market-cap band or index membership, and loosening the VStop ATR multiplier, would move trade count faster than any Test arm above — and are excluded on purpose. They'd change the universe or the signal definition itself, which `vstop-strategy-revision-plan.md` §1 already flagged as evidence-spending tinkering rather than a mechanism-driven test. If either is ever wanted, it's a new registered variant (its own id, its own dev-set test, its own kill criterion) in the existing V-series — not a Test arm in this plan, which exists specifically to hold the spec fixed.

### 3.7 T1's first live week — what it says, and how T1 gets refined (Control untouched)

`fwd_2026-08-31` is T1's first graded week. Result: **T1 basket −0.61% net across 17 trades, against Control's +1.66% on its 1 trade.** Four of the 17 (23.5%) hit their full −1R stop within the week — a stop-out rate the 104-week backtest behind Control didn't produce at this frequency. Separately, 4 more candidates T1 caught mid-week had already reversed by Friday and were correctly never traded (`n_extra_reversed: 4`).

**This is one week. It does not kill T1** — §3.5's gate is ~13 weeks away, and n=17 trades in a single week carries about as much statistical weight as n=1 week of Control. But it's also not nothing: a 23.5% full-stop rate and a pooled negative week are exactly the kind of early signal worth *instrumenting further*, not reacting to. Four refinements, none of which touch Control or loosen any condition in §3.1:

1. **Audit T1's rolling-window code against the same boundary-inclusivity discipline the project already applies to Control.** The jump from Control's 4 weekly VStop flips to T1's 21 (17 confirmed + 4 reversed) in the same week is large. Before reading any signal into this week's weak result, confirm T1 is checking the *identical* thresholds (VStop(10,2), RSI 50≤x≤65 inclusive, same cap band and liquidity floor) on each rolling window — not a subtly looser version of the rule. This is the cheapest check and should happen before anything else; it's also exactly the class of silent, flattering-or-unflattering bug `vstop-screener-test-plan.md` §1 already ranks as the most dangerous kind.
2. **Stop pooling T1 into one basket — split it by window offset.** T1 currently lumps every rolling-window catch (Monday-anchored, Tuesday-anchored, etc.) into a single 17-name basket. Recording which offset each pick came from and grading offsets separately will show whether the stop-outs and the loss are concentrated in specific offsets (e.g., flips caught very early in the week, with more days for the move to run before the stop has ratcheted) or spread evenly. That's the difference between "prune one weak offset" and "the whole mechanism needs rethinking" — and right now the pooled number can't distinguish them.
3. **Add "days since flip" as a recorded field on every T1 pick.** A signal confirmed Monday and one confirmed Thursday are mechanically different bets — the Monday one has more room for the position to move against the stop before Friday's entry. Recording this lets the eventual review test directly whether stop-out rate correlates with how early in the window the flip fired, rather than guessing from the pooled basket.
4. **Keep tracking the reversal rate (`n_extra_reversed / (n_extra_reversed + n_extra_confirmed)`) as T1's own health metric**, separate from basket return. This week it's 4/21 ≈ 19%. A rising reversal rate over time would say the rolling-window relaxation is mostly finding noise that resolves itself; a falling one says the confirmed catches are getting more reliable.
5. **Build toward a composite per-candidate score** — see §3.8 for the full feature list. Not live, not weighted, and not a selection change; a later, separately tested layer on top of whichever T1 candidates items 1–4 leave standing.

None of this is a parameter change, a threshold change, or a change to Control. It's additional instrumentation on T1 specifically, so that when the ~13-week review in §3.5 comes, the answer can say *why* T1 did or didn't work — offset-by-offset and by days-since-flip — instead of only a single pooled number that this week's result already shows can mask very different things happening inside it.

### 3.8 Parameter list for a composite T1 candidate score (feeds T1 refinement item 5, and T3)

§3.7's refinements tell us *where* to look inside T1's pooled basket. The complementary question is whether a **per-candidate score** can separate winners from stop-outs before the fact, not just explain them after. This is a **parameter list, not a weighting scheme yet**: per B6 in `selection-and-analysis-improvement-plan.md`, any such score gets rank-IC tested against forward return before it's trusted with anything — weights are a conclusion, not an input. It slots in as T1 refinement **item 5**, and doubles as the feature set T3's confidence-weighted allocation (§3.2) would eventually draw on.

**Scoring-architecture principle (new in v0.7):** the parameters below split into two kinds that must not be blended into one number the same way. *Edge-signal* parameters (3.8.1) are what the rank-IC test is actually trying to validate — they're allowed to move the score up or down continuously. *Risk-guardrail* parameters (3.8.2) describe how much room a candidate has before it breaches a hard limit we already enforce elsewhere (the 15% risk cap, the liquidity floor, the market-cap band) — these should **gate or discount** the score, not add to it, the same way sector RS is already a soft input while the risk cap is already a hard filter in `build_trades()`. Folding a guardrail into an additive blend lets "safely far from the cap" outscore "genuinely better setup," which is exactly the kind of thing B6's rank-IC test would then validate for the wrong reason. §6 records the open decision on exactly how gating vs. discounting is implemented.

**Control impact: none.** Every parameter in 3.8.1 and 3.8.2 is read off T1 candidates only, in shadow mode — nothing here touches `config/rules.yaml`, the universe, VStop(10,2), RSI[50,65], the 15% risk cap, or Control's equal-weight sizing, and nothing here runs inside `record()` or `build_trades()` as Control calls them. §3.1's "Control — defined once, frozen" still holds exactly as written: Control keeps running unmodified, keeps taking the real capital, and keeps being logged in `forward-test-log.md` the same way, whether or not a T1 score ever ships. The score is scoped to T1's own candidate list (and, per §3.2, to T3's reweighting of Control's *existing* trade list) — it can change how T1/T3 are read or ranked, never what Control screens, selects, or sizes.

#### 3.8.1 Edge-signal parameters (what the rank-IC test evaluates)

Already on every trade record today — zero new computation:
- `confidence` — the engine's existing composite score (the one B6 already plans to rank-IC test on its own).
- `rsi` — raw value; **RSI band centrality** = `1 − |rsi − 57.5| / 7.5` (one-line derivation) may carry different information than a bare in/out-of-band flag.
- `RR` (reward:risk) — already computed as `rr_comp` in `build_trades()`.
- Trend quality — `(close − SL) / atr`; already computed.
- Volume ratio — `volume / avg_vol_8w`; already computed.
- Sector RS — `rs_4w` / `rs_13w` and the `outperforming` flag; already computed, already soft by design.

New, needs §3.7's T1 instrumentation done first (item 5 depends on items 2–3):
- **Days-since-flip** (item 3) — how early in the window the signal confirmed. Not yet recorded anywhere in `record_t1_shadow()`.
- **Window-offset identity** (item 2) — which rolling anchor caught it, once offsets are split out. Not yet recorded.
- **Per-ticker historical reversal frequency** — how often *this name specifically* has shown up in `extra_reversed` in past weeks. Needs enough T1 history to compute at all (not available with only one or two graded T1 weeks) — §6 records an open question on a minimum-history threshold before this is trusted.

Flagged, not started — deliberately excluded pending a separate decision:
- **Signal-week pop size** (the move into the flip) — available today, but `vstop-strategy-revision-plan.md` §1 already closed pop-size *as a standalone filter* (no subset of the 244-trade backtest was profitable on it). Including it as one continuous input to a multi-feature score is a different question from using it alone as a gate, but it's re-opening ground the project deliberately closed — leave out of the v1 score; any test using it should say so explicitly and treat a positive result with extra suspicion.

#### 3.8.2 Risk-guardrail parameters (gate or discount, never blend as edge)

- **Risk-cap headroom** = `0.15 − R_pct_of_close/100`. How much margin a name has below the 15% cap, not just whether it's under it — Graphite (15.70%, rejected) and Tejas (18.92%, rejected) failed by very different amounts; headroom distinguishes them, a pass/fail flag doesn't. Note: `R_pct_of_close` is computed off the signal-week's close (a same-day proxy), while the cap actually enforced in `build_trades()` is `R/EP` — usually close but not guaranteed identical; treat headroom as a proxy, not the exact enforced quantity.
- **Liquidity multiple** = `turnover_cr / 10`. Same floor as today, continuous instead of binary — headroom above the liquidity floor, not just pass/fail.
- **Market-cap band position** — how centered vs. edge-of-band (₹10–50k cr) a name sits. A name near 49k cr is one good week from falling out of the universe entirely; that's a guardrail fact about durability, not an edge signal.
- **ATR** (absolute volatility) — cross-check against `R_pct_of_close`, since two names can share the same %-risk with very different absolute volatility (relevant to T2's sizing, not just T1's score).
- **Weekly survivor count** — not per-candidate, but relevant context: a candidate scored highly in a 1-survivor week and a candidate scored highly in a 12-survivor week aren't competing for capital the same way. Worth carrying alongside the score, not folded into it.

**What this is not, yet:** a ranking formula, a set of weights, or anything that changes which T1 candidates get traded. The next step — separate from this plan — is B6's rank-IC test, run first on the existing single `confidence` score, then extended to whichever of 3.8.1's parameters are cheap enough to add before the next T1 review, with 3.8.2 wired in as a gate/discount rather than a blended input. 3.8.1's sector-RS is cheap and fine to include; the pop-size entry stays flagged, not included.

### 3.9 T4 — Flag-count selection

Registered 15 Sep 2026, per `docs/feature-flag-matrix-plan.md` §7 (the full spec for
the weekly feature-flag condition matrix this Test arm is built on top of).
Registration is recorded here **before** any replay run that produces T4
numbers, per this section's own ordering rule and §3.5's pre-registration
discipline.

| field | value |
|---|---|
| **id** | T4 — Flag-count selection |
| **Mechanism (only this changes)** | Weekly shadow basket = eligible stocks with `A02=1` AND `A04=1` AND `flags_met ≥ K`, top `max_names=10` by tie-break order (`flags_met desc, median_weekly_turnover_cr desc, ticker asc`), equal weight, EP = next-week open, SL = `vstop_line`, Control's gap-stop-aware 1-week exit, 0.5% round trip. |
| **Identical to Control** | Universe/base gate, VStop/RSI definitions, risk cap (A04 is a hard requirement), exit rule, costs. |
| **Different from Control (acknowledged)** | Does **not** require a flip or RSI band — it is a selection change, closer to the V-series than T1–T3 (§3.6, `.claude/HARNESS.md` §9). Registered as a Test arm by Dharmin's explicit decision (15 Sep 2026); it never touches Control's picks or capital. |
| **Hypothesis** | Stocks meeting more registered conditions earn higher 1-week excess return than the eligible universe and than Control's basket. |
| **Kill criteria** | (a) VALIDATE replay mean weekly net ≤ 0 → retire before forward start. (b) At 26 forward weeks, paired T4−Control CI includes or is below zero → stays shadow/retired. (c) `flags_met` rank-IC CI at 26 forward weeks includes zero → matrix is not an ordering signal; T4 retired. |
| **Graduation** | At `REAL_READ_WEEKS = 26` **forward-mode** weeks only: T4 mean weekly net > 0 AND paired weekly `T4 − Control` bootstrap CI lower bound > 0. One decision, no second look (§3.5.4). `FIRST_LOOK_WEEKS = 13` is informational only. |

**Weekly comparison rules:** a week with zero T4 names or zero Control trades
counts as 0.0% return for that arm — never dropped (this project's own §7
"flat weeks dropped" defect, avoided deliberately here). Pair by
`signal_week`, never by array position. Only `forward` records count toward
the gates above; `late_backfill` and `replay` never do.

**Why A02 + A04 are hard requirements:** without an uptrend and a valid
≤15% stop, there is no Control-comparable SL and the exit rule is undefined
— this keeps T4 inside Control's risk envelope.

**Choosing K:** one-time, pre-registered DEV/VALIDATE protocol against 104
weeks of replay (`docs/feature-flag-matrix-plan.md` §7.3) — see
`docs/forward_test_findings.md` for the dated entry recording the result.

### 3.10 Threshold experiment — risk-cap sweep

Registered 15 Sep 2026 by Dharmin's explicit decision. Full spec, decisions and invariants:
`docs/threshold-experiment-plan.md`. Registration is recorded here before any forward week is
graded; the only data looked at beforehand were survivor **counts** by R% band (no returns).

| field | value |
|---|---|
| **id** | `threshold-experiment` — arms `threshold-experiment_15`, `_17.5`, `_20`, `_22.5`, `_25`, `_30`, `_40`, `_50` |
| **Mechanism (only this changes)** | Per arm, Control's survivors split into SELECTED (`(signal_close − vstop_line_SL)/signal_close ≤ cap/100`) and REJECTED (above it). Equal weight; Control's own gap-stop-aware 1-week grade and 0.5% cost. |
| **Identical to Control** | Universe, liquidity floor, VStop/RSI, exit rule, costs, sizing method. `_15` reproduces Control exactly (invariant X1/X6). |
| **Different from Control (acknowledged)** | Loosens the 15% risk cap — the change §4 says not to make on one week's evidence. Shadow only; Control's cap and capital are untouched. |
| **Hypothesis** | Names rejected by the 15% cap do no worse over one week than names it keeps. |
| **Kill** | At 26 forward weeks: paired `selected − Control` CI upper bound < 0, or REJECTED-basket CI upper bound < 0 → arm retired. |
| **Graduation** | At 26 forward weeks: paired weekly `selected − Control` bootstrap CI lower bound > 0 with BH q < 0.05 across arms that differ from Control. One decision per arm. A graduating arm is a proposal to change `rules.yaml`, decided separately. |

**Comparison rules:** zero SELECTED names = 0.0% that week, never dropped; zero REJECTED names = no
rejected basket that week. Only `forward` records (picks and threshold record both before Monday
09:15 IST) count. Forward-only — no historical replay unless explicitly requested, and then as dev
evidence only.

**Note on the grid:** on a flip bar `R/EP = 2·ATR/close`; across 576 replay survivors it never
exceeded 27.7%, so `_30`, `_40` and `_50` are expected to equal "no cap" almost every week.

### 3.11 Literal — Dharmin's five-step brief, run without our interpretations

Registered 26 Sep 2026, per `docs/literal-spec-plan.md` (the full spec, gap-by-gap
comparison against Control's interpretation, and decisions 1–9). Unlike T1–T4 and the
threshold experiment above, **Literal is not a Test arm and §3.5's graduation gate does not
apply to it** — it does not compete against Control for a single verdict, it is a second,
independently frozen implementation of the same five-step brief, kept running in parallel so
the effect of the original interpretation gaps (G1–G10, `docs/literal-spec-plan.md`) is
visible week by week.

| field | value |
|---|---|
| **id** | Literal |
| **Mechanism (only this changes)** | Universe = full NSE equity list (not the ~500-index proxy), history from 2024-01-01; signals = VStop(10,2) weekly `flip_up` AND RSI in [50, 65] (`combine: AND`); sector benchmark Nifty 50 (`^NSEI`), relative-strength lookbacks [4, 13, 1] weeks, report-only (no filter); trade EP = signal close, SL = VStop line, **no risk-cap filter** (`max_r_pct: null`), one confidence score. Own config `config/rules_literal.yaml`, own universe/weekly-bar cache, own immutable record/grade cadence (`tests/track_literal.py`), never touching Control's files. |
| **Identical to Control** | VStop(10,2) recurrence, RSI(14) formula, weekly cadence, gap-stop-aware grading, 0.5% round-trip cost, the single shared `run_screen()` funnel (parameterized by `rules_literal.yaml` instead of `rules.yaml`). |
| **Different from Control (acknowledged)** | Universe (full list vs. index proxy), no 15% risk-cap filter, T1 rescoped as a rolling Friday-window loop over Literal's own universe rather than the mid-week scan Control's T1 used. Each difference traces to a specific gap in `docs/literal-spec-plan.md`'s comparison table, not an unregistered strategy change. |
| **Hypothesis** | None — Literal is not being tested against Control for edge. The question it answers is whether the five-step brief, implemented without the interpretation choices listed as gaps, behaves differently from Control's numbers, not which one is "better." |
| **Kill / graduation** | Not applicable — there is no gate to clear and no capital decision attached. Control keeps recording for 4–6 weeks alongside Literal for a side-by-side read, then stops unless Dharmin wants it kept (`docs/literal-spec-plan.md`). |

**Comparison rules:** same as Control's own (§3.4) — zero-survivor weeks count as 0.0%,
never dropped; only `forward` records count as forward evidence; replay history back to
2024-01-01 is backtest evidence, not forward evidence, even when it uses the exact same
`run_screen()`/`grade_horizons()` code path as the live week.

**Old Control-interpretation results stay in the ledger, unchanged:** the −1.37%/trade
104-week walk-forward and every T1/threshold-experiment finding recorded before this section
remain labelled "Control interpretation" — they are not evidence for or against Literal, and
nothing about registering Literal edits or supersedes them (rule 6, append-only findings).

---

## 4. What not to do

- Do not loosen the RSI band or the risk cap based on this one week.
- Do not let any Test arm touch real capital before it clears §3.5 — shadow logging only until then.
- Do not widen the universe or the VStop sensitivity to chase trade count inside this plan — that path exists (the V-series), this isn't it.
- Do not let a good (or bad) forward-test week change the phase-3/4/5 sequencing gates already agreed (dev set only, one validation pass, frozen finalists).
- Do not judge T1 on one week in either direction — the point of §3.7 is better instrumentation, not an early verdict.

*Dated note, 15 Sep 2026:* the risk-cap rule above still holds for Control. The cap is now studied in shadow only, as the registered threshold experiment in §3.10.

---

## 5. Immediate, time-sensitive action

Standing rule 1 in `forward-test-log.md`: *"Record before the week opens. A pick logged after Monday's open is not a forward test."* The signal week Mon 7 Sep–Fri 11 Sep has already closed; its forward-test record (Control, and T1 alongside it) needs to be logged **before market open tomorrow (Mon 14 Sep 2026, IST)** or that week's evidence is lost to the log, not just delayed.

---

## 6. Open decisions

1. Which of the §3.7 T1 refinements to implement first — the boundary-inclusivity audit (item 1) is the cheapest and should happen regardless of the others; offset-splitting and days-since-flip (items 2–3) are instrumentation for the next several weeks; the composite score (item 5 / §3.8) waits on items 2–3 and on B6's rank-IC methodology, so it's the last of the five, not urgent this week.
2. Whether §3.8(D)'s signal-week-pop-size feature is worth re-testing inside a multi-feature score at all, given `vstop-strategy-revision-plan.md` §1 already closed it as a standalone filter — in scope for the score, or excluded from the feature list entirely?
3. Daily bars priority (existing, motivated by T1 as well as V3/V4 entry timing).
4. Extended history (existing): pull 10+ years now for a clean holdout, or accept the partly-spent validation window.
5. Regime gate V6 (existing): still out unless you say otherwise.
6. Shorting V7 (existing): diagnostic only, or a real candidate if the inverse confirms.
7. §3.8 scoring architecture: implement risk-guardrail parameters (headroom, liquidity multiple, band position) as a multiplicative discount on the edge-signal score, or as a hard gate below some threshold, or just as separate ledger columns with no single blended number at all?
8. §3.8.1 per-ticker reversal frequency: what's the minimum number of past T1 appearances before this parameter is trusted enough to include, given only one or two T1 weeks are graded so far?
9. §3.8 v1 scope: ship a first version of the score from 3.8.1 + 3.8.2's already-computed parameters now, or wait until §3.7 items 2–3 (window-offset, days-since-flip) land so the full parameter set is available at once?
10. Threshold experiment (§3.10): decisions D1–D5 settled 15 Sep 2026 (grid 15/17.5/20/22.5/25/30/40/50; plain arm names; `R <= 0` removal kept; equal-weight SELECTED vs REJECTED; forward-only). Open: whether to run a historical replay if forward weeks show a signal.
