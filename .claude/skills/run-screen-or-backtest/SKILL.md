---
name: run-screen-or-backtest
description: Run a one-off live screen or a walk-forward backtest for validation via scripts/run_screen.py or scripts/run_backtest.py — not the recorded weekly forward-test cadence.
---

# Run screen or backtest

For "what does the screen say right now" or "how has this held up historically" — not the
pre-registered weekly record/grade cycle (`weekly-forward-test`), which is immutable and
time-sensitive; this is a repeatable, no-side-effects check.

## Procedure

1. **Live screen**: `python scripts/run_screen.py [--as-of YYYY-MM-DD] [--limit N] [--out
   results/live]` — prints the funnel, trade table, and sector highlights. `--as-of` defaults to
   the latest available Friday; `--limit` truncates the universe for a quick smoke test. **This
   does not write an immutable forward-test record** — if the user seems to want that, point them
   to `weekly-forward-test` instead.
2. **Backtest**: `python scripts/run_backtest.py [--weeks N] [--limit N] [--out
   results/backtest] [--trend-hold]` — runs a single-week check plus the rolling walk-forward
   (defaults to `rule_spec.validation.walk_forward_weeks` = 104 weeks); `--trend-hold` adds the
   secondary trend-hold exit report.
3. **Always restate the caveat before presenting backtest numbers**: the current 104-week
   walk-forward result is negative expectancy (-1.07%/trade, Sharpe -2.6), and the harness carries
   the known defects in `.claude/HARNESS.md` §7 (gap-fill mis-pricing, dropped zero-pick weeks,
   trend-hold look-ahead risk) — don't report a Sharpe or return number as clean without noting
   this.
4. **Deeper diagnostics, as needed**: `scripts/rsi_param_study.py` (RSI band sensitivity sweep),
   `scripts/survivorship_check.py` (quantifies survivorship-bias exposure from the data caveats).
5. **Never use a finding from this skill to edit `config/rules.yaml` directly.** A result here
   feeds into a proposed Test arm (`add-test-arm`) or a documented open decision in the plan doc
   — not a live parameter change.

## Guardrails (from `.claude/HARNESS.md`)

- **Single shared code path** — both the screen and backtest go through `run_screen()`; don't
  reimplement filtering logic for a "quick" variant.
- **Negative-expectancy + known-defects caveat** on every backtest number presented.
- **No writes to `config/rules.yaml`** from this skill.
