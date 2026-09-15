---
name: add-test-arm
description: Propose or modify a T-series shadow experiment (like T1/T2/T3) on top of the frozen Control rule, following the Test-vs-Control design in docs/forward-test-response-and-volume-plan.md.
---

# Add or modify a Test arm

For proposing a new shadow experiment layered on top of Control (in the style of T1's rolling
daily scan, T2's fixed-fractional sizing, T3's confidence-weighted allocation) — not for changing
Control itself, which this skill must never do.

## Procedure

1. **Read the plan doc's Test-vs-Control design first**:
   `docs/forward-test-response-and-volume-plan.md` §3.1–§3.6 — how Control is defined and frozen,
   how a Test arm is a separately-registered experiment, how Test and Control run side by side,
   what metrics get compared every graded week, and the graduation gate that decides when (if
   ever) an arm is allowed to touch real capital.
2. **Define the arm as a pure addition.** Follow the existing pattern: `daily_scale.py` deep-copies
   `rule_spec` and scales only what needs to change; `candidate_score.py` computes a new column
   without touching `run_screen()`/`build_trades()`'s own selection or sizing. A new Test arm
   should be the same shape — a new module/function that *derives from* Control's output or a
   deep-copied spec, never a hand-edited `config/rules.yaml`.
3. **Wire shadow-only recording**, following `record_t1_shadow()` / `grade_t1()` in
   `tests/track_forward.py` as the template — the arm records and grades in parallel with
   Control, writing to its own output file, never overwriting or altering a Control
   `picks_*.json`.
4. **Define the kill/graduation criterion up front, before any data is collected.** E.g. a
   pre-registered rank-IC or bootstrap-CI threshold. The criterion can't be chosen or adjusted
   after seeing results — that's what makes it a real gate rather than a post-hoc justification.
5. **Document the arm** as a new numbered subsection in `docs/forward-test-response-and-volume-plan.md`
   (alongside the existing T1/T2/T3 definitions) and wire its columns into
   `rebuild-test-control-dashboard`'s data sources — don't leave a live arm undocumented in the
   central plan.
6. **Confirm real-capital eligibility only via the pre-registered statistical gate** — bootstrap
   CI excludes zero at the `FIRST_LOOK_WEEKS=13` / `REAL_READ_WEEKS=26` review points — never by
   discretion after a good week.

## Guardrails (from `.claude/HARNESS.md`)

- **Zero impact on Control**: never modify `config/rules.yaml`, `run_screen()`, or
  `build_trades()`'s existing selection/sizing behavior.
- **No real capital before the gate clears** — shadow mode only until the pre-registered
  criterion is met.
- **Don't judge on one week**, in either direction.
- **Don't widen the universe or loosen predicates to raise trade volume** — that's separate
  "V-series" work per v0.7 §6, not a Test-arm task.
