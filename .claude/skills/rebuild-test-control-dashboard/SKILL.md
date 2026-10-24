---
name: rebuild-test-control-dashboard
description: Regenerate docs/dashboards/test-vs-control-ledger.html from the latest Literal / T1-on-Literal records after a grade or replay run.
---

# Rebuild the Literal & T1 ledger dashboard

**26 Sep 2026 rescope**: this dashboard no longer covers Control, T2, T3, the threshold
experiment, or T4 — see `docs/forward_test_findings.md`'s 2026-09-26 entry ("Dashboard
rebuilt around Literal + T1 only") for why. Control's own forward-test record keeps
recording independently through its wind-down date; it's just not shown on this page
anymore. The filename (`test-vs-control-ledger.html`) is kept as-is to match existing
references (this skill, `CLAUDE.md`) even though it no longer describes the content —
don't "fix" the filename without checking in first, since it fans out into every doc
that links it.

The dashboard is a companion artifact meant to be rebuilt after each grade/replay run —
treat it as generated from data, not a hand-authored page you patch numbers into.

## Procedure

1. **Confirm the latest data has actually been graded/replayed**
   (`tests/track_literal.py:grade()`/`t1grade()` for a real forward week, or
   `replay()`/`t1replay()` for a retrospective refresh) before rebuilding — this skill
   consumes that output, it doesn't produce it.
2. **There is currently no generator script for §02/§03** (Literal replay, T1-on-Literal
   replay) — those two sections are still hand-maintained HTML; check `src/report/` and
   `scripts/` again in case one has been added since this was written, but as of the 2026-09-29
   update there still isn't one for them. The 2026-09-26 rebuild used a one-off local script to
   turn those replay CSVs into table rows (not committed — see the dated findings entry); if
   you find yourself doing that by hand repeatedly, flag to the user that formalizing it would
   remove the copy-paste risk, rather than building one unprompted.

   **§04 (Step 5 extended: 1-/2-/3-week horizon grading) is different — it DOES have generator
   scripts, added 27 Sep 2026 and used again for the 2026-09-29 RSI-fix restatement below:**
   `scripts/build_horizons_dashboard_tables.py` (`tables` subcommand → the per-week "every
   week" table rows for both signal/trade views, plus the "most recent N weeks" ticker-detail
   table; `trend_data` subcommand → the `HORIZON_DATA` JS blob the §04 trend-line charts read)
   and `scripts/extract_literal_horizons_dashboard_data.py` (the summary table's mean
   return/hit-rate/mean-alpha/block-bootstrap-CI/non-overlapping-sanity-CI numbers, one row per
   horizon/view). Both read `results/literal_test/replay/horizons_replay_*.jsonl` and print
   ready-to-splice output; the HTML edit itself is still manual (locate the `<tbody>` by its
   preceding `card-head` text, replace its contents with the script's `<tr>` output — see the
   2026-09-29 entry below for the exact procedure that was used).
3. **Source the numbers from `results/literal_test/`**:
   - Literal's own series: each graded record's `graded` block
     (`results/literal_test/picks_<date>.json` — `basket_close_to_close_pct`,
     `basket_trade_result_net_pct`) for real forward weeks, or
     `results/literal_test/replay/literal_replay_<start>_<end>.csv` for a retrospective
     refresh (backtest evidence — label it as such, never as a forward record, per
     HARNESS rule 4).
   - T1-on-Literal: `results/literal_test/t1_picks_<date>.json` (`graded.basket_net_pct`)
     for real forward weeks, or `results/literal_test/replay/t1_ledger_grades.csv` /
     per-week `t1_<date>_graded.csv` for a retrospective refresh.
   - Don't recompute basket returns by hand from raw picks; read them from the
     already-graded/replayed output so the dashboard can't drift from what
     `track_literal.py` actually computed.
4. **Preserve the existing visual system** — the dashboard uses CSS custom properties for
   its light/dark theme (`--gain`/`--loss`/`--flag`-style tokens) and IBM Plex/Newsreader
   fonts. Match it rather than introducing a new style per rebuild.
5. **Keep replay (backtest) and any future real forward record visually distinct** — a
   week scored after its outcome is already known (`replay()`/`t1replay()`) is not the
   same evidence as a pre-registered forward record (`record()`+`grade()`); label which
   is which, don't blend them into one series.

## Guardrails (from `.claude/HARNESS.md`)

- **Only graded data** — never present an in-flight/ungraded `picks_*.json` as if it were a
  result.
- **Known data caveats** apply to any derived number shown (survivorship bias, no PIT shares
  outstanding — see `.claude/GLOSSARY.md` / `adapter.KNOWN_CAVEATS`).

## Trigger: an indicator/methodology fix, not just a new week (added 2026-09-29)

A rebuild isn't only triggered by a fresh forward week — a fix to a **shared computation**
(`src/indicators/rsi.py`, `src/indicators/vstop.py`, anything `run_screen()` calls) changes
every already-replayed backtest number too, and the dashboard goes stale the moment the
underlying replay is re-run, even if no calendar week has passed. Example: the 2026-09-29
RSI(14) seeding fix (see `docs/forward_test_findings.md`'s dated entry) — `compute_rsi()`'s
seeding changed, `tests.track_literal replay_horizons` was re-run over the same
2024-01-01→2026-09-21 range (5352 graded rows, was 5346 — small shifts, concentrated in
short-history tickers), and §04 needed the same rebuild treatment as any other refresh:
`extract_literal_horizons_dashboard_data.py` for the summary table, then
`build_horizons_dashboard_tables.py tables` for the two "every week" tables and the
ticker-detail table, then `trend_data` for `HORIZON_DATA`. Nothing else about the procedure
changes — this is still "read from already-replayed output, splice into the existing
`<tbody>`/`<script>` blocks" — the only difference is *why* a rebuild was needed (an upstream
fix, not new data). If you're rebuilding for this reason, say so in whatever findings entry
accompanies the fix (dated, old→new numbers) rather than only in the dashboard itself, since
the dashboard has no changelog of its own.
