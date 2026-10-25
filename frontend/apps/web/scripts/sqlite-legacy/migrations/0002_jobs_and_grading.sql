-- apps/web/src/server/db/migrations/0002_jobs_and_grading.sql
PRAGMA foreign_keys = ON;

CREATE TABLE entry_events (
  event_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id   INTEGER NOT NULL REFERENCES watchlist_entries(entry_id),
  run_id     INTEGER REFERENCES runs(run_id),
  type       TEXT NOT NULL,
  from_value TEXT, to_value TEXT,
  at         TEXT NOT NULL
);
CREATE INDEX ix_events_entry ON entry_events(entry_id, at);

CREATE TABLE validations (
  run_id            INTEGER NOT NULL REFERENCES runs(run_id),
  horizon_w         INTEGER NOT NULL CHECK (horizon_w IN (1,2,3)),
  n                 INTEGER NOT NULL,
  ew_return         REAL, control_ew_return REAL, hit_rate REAL,
  computed_at       TEXT NOT NULL,
  PRIMARY KEY (run_id, horizon_w)
);

CREATE TABLE jobs (
  job_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  prompt_id  INTEGER REFERENCES prompts(prompt_id),
  as_of      TEXT,
  status     TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','blocked_stale_data')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  error      TEXT, created_at TEXT NOT NULL, finished_at TEXT,
  UNIQUE (type, prompt_id, as_of)
);
