---
name: weekly-flag-matrix
description: Run, audit, or explain the weekly feature-flag condition matrix and T4 shadow arm (tests/track_flags.py) — pre-open recording, immutability, and week-clustered statistics apply.
---

# Weekly feature-flag condition matrix

Treat this skill as the tail of `weekly-forward-test`, not a standalone schedule — the flag
matrix only ever runs as a chained step of the weekly stock-selection run
(`scripts/weekly_selection_run.sh`), keyed off the exact `as_of` that Control's own `record()`
just produced. See `docs/feature-flag-matrix-plan.md` (full spec) and `.claude/HARNESS.md` (rules
that still apply — this spec adds to HARNESS, never relaxes it).

## Procedure

1. **Timing check first.** `python -m tests.track_flags preflight --as-of auto` — confirms the
   week has closed and reports the resolved `forward`/`late_backfill` mode. Never record a
   partial week.
2. **Never re-record.** A `flags_<wk>.csv`/manifest pair refuses to be overwritten, same as
   `picks_*.json` — this is enforced in code (`tests/track_flags.py:record()`), not just
   convention.
3. **Trigger, don't run standalone.** The normal entry point is
   `python -m tests.track_flags on-selection --picks results/forward_test/picks_<wk>.json`, called
   right after Control's own `record()` for that week (see `scripts/weekly_selection_run.sh` for
   the full chained order: grade last week -> select this week -> flag trigger -> audit). Running
   `record`/`grade` directly is for debugging or backfill only.
4. **After `on-selection` succeeds**, invoke the `flag-run-auditor` agent with the resolved week
   (`WK=<as_of date>`). It follows a fixed decision table over deterministic tool output — it
   never computes, edits, or judges a number itself (see the agent file for the exact contract).
5. **Whether a findings entry gets appended is decided by code**, not by this skill or the
   agent — `python -m tests.track_flags findings-append --as-of WK` only writes when
   `noteworthy.any` is true, and only once (idempotency marker). Don't hand-write a findings
   entry to work around a "not noteworthy" exit.
6. **Then hand off to `rebuild-test-control-dashboard`** to keep the ledger dashboard in sync,
   same as the Control cadence.
7. **Periodically**: `python -m tests.track_flags scorecard --mode forward` (and
   `--mode replay` for dev evidence) for the per-flag lift/rank-IC table — never read it before
   `FIRST_LOOK_WEEKS=13` forward weeks, and don't treat 13-25 weeks as a real read
   (`REAL_READ_WEEKS=26`).
8. **T4 status**: check `config/feature_flags.yaml`'s `t4.k`. If `null`, T4 has not graduated
   past its DEV/VALIDATE calibration (or was retired by kill criterion (a) — see
   `docs/forward_test_findings.md` for the dated entry) and produces no picks; don't present it as
   live. If set, T4 picks are still shadow-only until the §7 graduation gate clears — every status
   output must label them `SHADOW — not for trading`.

## Guardrails (from `docs/feature-flag-matrix-plan.md` §9 and `.claude/HARNESS.md`)

- **Single screening path** — the eligible set comes only from
  `run_screen(include_eligible_features=True)`; never a second parallel funnel.
- **Immutable records, append-only ledgers** — a `flags_*.csv`/manifest pair is never rewritten;
  a duplicate ledger key raises rather than silently overwriting.
- **Missing ≠ false** — an unevaluable flag is blank, excluded from `flags_evaluable`, never
  recorded as 0.
- **No verdict before maturity** — `FIRST_LOOK_WEEKS=13` / `REAL_READ_WEEKS=26`, week-clustered
  bootstrap CIs, BH correction shown. Never judge a flag or T4 on a handful of weeks.
- **T4 stays shadow** until it clears its own pre-registered graduation gate (plan doc §3.9) —
  it never touches real capital or Control's own picks/sizing.
- **The agent computes nothing** — if `flag-run-auditor` is ever asked to "just fix the number,"
  that request is out of scope for it; a number only changes by editing the deterministic tool
  code and re-running, never by hand.
