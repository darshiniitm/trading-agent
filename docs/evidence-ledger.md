# Evidence ledger — which studies have read returns, where

Append a row whenever a study reads **returns** (not counts) in a window. This is the auditable
multiple-testing denominator and the reason `holdout_ext` exists. Machine-written reads also land in
`results/evidence/segment_reads.csv` via `src/data/segments.py:record_read()`.

| date | study | window read (signal weeks) | segment today | what it decided |
|---|---|---|---|---|
| 2026-08-29 | 104-week walk-forward (`vstop-test-results-2026-08-29.md`) | 2024-08 → 2026-08 | dev | Control is negative expectancy |
| 2026-08-29 | Mechanism forensics (pop quartiles, timing split, alpha vs universe) | 2024-08 → 2026-08 | dev | Selection closed; horizon/entry open |
| ≤ 2026-08-29 | RSI band study (`scripts/rsi_param_study.py`, 52 train + 52 validate) | 2024-08 → 2026-08 | dev | No band rescues the strategy |
| 2026-09-15 | Flag-matrix 104-week replay + scorecard | 2024-09-09 → 2026-08-31 | dev | Dev evidence for flags |
| 2026-09-15 | T4 DEV/VALIDATE K calibration | 2024-09-09 → 2026-08-31 | dev | T4 retired (kill a) |
| 2026-09-15 | Threshold experiment sizing | same replay | dev | **counts only**, no returns |
| 2026-09-16 | Harness defect-fix baseline restatement | 2024-09-09 → 2026-08-31 | dev | Portfolio series corrected; still negative |
| 2026-09-16 | `holdout_ext` universe sizing | 2019-12-02 → 2021-06-28 | holdout_ext | **counts only**, no returns |
| 2026-09-16 | V2 fixed N-week hold dev backtest (`scripts/run_v2_backtest.py`) | 2021-07-05 → 2024-07-01 | dev | N=2/4/8 all positive expectancy on dev; kill not triggered |
| 2026-09-16 | V3 pullback-limit + V4 same-week-confirmation dev backtest (`scripts/run_v3_v4_backtest.py`) | 2021-07-05 → 2024-07-01 | dev | Both beat Control's own paired 1-week baseline on the same signals; neither kill triggered |

Untouched for returns as of 2026-09-16: signal weeks 2024-07 → 2024-08 (dev, ~4 weeks unread) and
2019-12 → 2021-06 (`holdout_ext`).
