# Migration reconciliation

Generated 2026-10-12 15:35. Any ✗ blocks cutover.

| Check | Source (files) | Target (Postgres) | Match |
|---|---|---|---|
| equity master symbols (≤ instruments) | 2601 | 2601 | ✓ |
| prices_daily rows / sum(close) | (see data_pipeline_log.ingestion_log) | 807682 / 1301116240.2994 | info |
| control candidates (picks+near_miss) | 7 | 7 | ✓ |
| control runs | 3 | 3 | ✓ |
| literal candidates (picks+near_miss) | 2 | 2 | ✓ |
| literal runs | 1 | 1 | ✓ |
| flag-matrix candidate rows | 526 | 526 | ✓ |
| threshold candidates (rows × 8 caps) | 40 | 40 | ✓ |
