-- Data resolution & fallback layer (docs/data-fallback-spec.md §7-§8).
-- Naming decisions against the existing schema:
--  * runs.status already holds the job lifecycle (queued/running/done/failed/...), so the spec's complete|partial|
--    low_coverage lives in runs.coverage_status.
--  * Stocks the engine could not decide (a `?` on a required condition and no `0`) are not candidates, so they cannot go
--    in run_results (membership is full_match|near_miss|rejected_risk_cap). They get their own table, run_unevaluated.
--  * data_gap_log lives in the engine's own meta sqlite (the engine is its only writer); the web app reads it through
--    /data/health. Per-run provenance is what belongs here.
PRAGMA foreign_keys = ON;

ALTER TABLE runs ADD COLUMN coverage_status TEXT CHECK (coverage_status IS NULL OR coverage_status IN ('complete','partial','low_coverage'));
ALTER TABLE runs ADD COLUMN coverage REAL;
ALTER TABLE runs ADD COLUMN universe_quality TEXT;
ALTER TABLE runs ADD COLUMN scored INTEGER CHECK (scored IS NULL OR scored IN (0,1));

ALTER TABLE run_results ADD COLUMN outcome TEXT CHECK (outcome IS NULL OR outcome IN ('qualified','rejected','unevaluated'));
ALTER TABLE run_results ADD COLUMN unknown_count INTEGER;
ALTER TABLE run_results ADD COLUMN reasons_json TEXT CHECK (reasons_json IS NULL OR json_valid(reasons_json));

CREATE TABLE run_condition_coverage (
  run_id       INTEGER NOT NULL REFERENCES runs(run_id),
  condition_id TEXT NOT NULL,
  coverage     REAL NOT NULL,
  unfeedable   INTEGER NOT NULL DEFAULT 0 CHECK (unfeedable IN (0,1)),
  PRIMARY KEY (run_id, condition_id)
);

-- One summary row per data type; per-symbol rows only where quality is not 'ok'.
CREATE TABLE run_provenance (
  run_id    INTEGER NOT NULL REFERENCES runs(run_id),
  data_type TEXT NOT NULL,
  symbol    TEXT,
  source    TEXT,
  as_of     TEXT,
  quality   TEXT,
  reason    TEXT
);
CREATE INDEX ix_run_provenance_run ON run_provenance(run_id, data_type);

CREATE TABLE run_unevaluated (
  run_id        INTEGER NOT NULL REFERENCES runs(run_id),
  symbol        TEXT NOT NULL,
  set_id        TEXT NOT NULL,
  unknown_count INTEGER NOT NULL,
  met_count     INTEGER NOT NULL,
  reasons_json  TEXT NOT NULL CHECK (json_valid(reasons_json)),
  cond_json     TEXT CHECK (cond_json IS NULL OR json_valid(cond_json)),
  PRIMARY KEY (run_id, symbol, set_id)
);
