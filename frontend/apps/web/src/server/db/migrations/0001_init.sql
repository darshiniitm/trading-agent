PRAGMA foreign_keys = ON;

CREATE TABLE users (
  user_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name   TEXT NOT NULL,
  email          TEXT UNIQUE,
  password_hash  TEXT,
  role           TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at     TEXT NOT NULL
);

CREATE TABLE prompt_drafts (
  draft_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(user_id),
  parent_prompt_id  INTEGER REFERENCES prompts(prompt_id),
  title             TEXT,
  prompt_text       TEXT NOT NULL CHECK (length(prompt_text) <= 2000),
  structure         TEXT CHECK (structure IN ('literal','t1_literal')),
  spec_json         TEXT CHECK (spec_json IS NULL OR json_valid(spec_json)),
  needs_input_json  TEXT CHECK (needs_input_json IS NULL OR json_valid(needs_input_json)),
  answers_json      TEXT CHECK (answers_json IS NULL OR json_valid(answers_json)),
  hypothesis        TEXT,
  kill_criterion    TEXT,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','confirmed','abandoned')),
  confirmed_prompt_id INTEGER REFERENCES prompts(prompt_id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX ix_drafts_user ON prompt_drafts(user_id, status);

CREATE TABLE prompts (
  prompt_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id     INTEGER NOT NULL REFERENCES users(user_id),
  draft_id          INTEGER NOT NULL UNIQUE REFERENCES prompt_drafts(draft_id),
  title             TEXT NOT NULL,
  prompt_text       TEXT NOT NULL CHECK (length(prompt_text) <= 2000),
  structure         TEXT NOT NULL CHECK (structure IN ('literal','t1_literal')),
  spec_json         TEXT NOT NULL CHECK (json_valid(spec_json)),
  spec_hash         TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','superseded','retired')),
  parent_prompt_id  INTEGER REFERENCES prompts(prompt_id),
  version           INTEGER NOT NULL DEFAULT 1,
  hypothesis        TEXT NOT NULL,
  kill_criterion    TEXT NOT NULL,
  tracks_stock_arm  TEXT CHECK (tracks_stock_arm IN ('literal','t1_literal')),
  review_week       INTEGER,
  confirmed_at      TEXT NOT NULL,
  closed_at         TEXT
);
CREATE INDEX ix_prompts_owner ON prompts(owner_user_id, status);
CREATE UNIQUE INDEX ux_prompts_owner_spec ON prompts(owner_user_id, spec_hash) WHERE status = 'confirmed';

CREATE TABLE prompt_conditions (
  prompt_id      INTEGER NOT NULL REFERENCES prompts(prompt_id),
  cond_no        INTEGER NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('filter','event','stop')),
  kind           TEXT NOT NULL CHECK (kind IN ('field','indicator')),
  name           TEXT NOT NULL,
  params_json    TEXT CHECK (params_json IS NULL OR json_valid(params_json)),
  op             TEXT NOT NULL,
  value_json     TEXT CHECK (value_json IS NULL OR json_valid(value_json)),
  value_origin   TEXT NOT NULL CHECK (value_origin IN ('prompt','user_answer')),
  source_phrase  TEXT,
  PRIMARY KEY (prompt_id, cond_no)
);
CREATE INDEX ix_conditions_name ON prompt_conditions(name);

CREATE TABLE watchlists (
  watchlist_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(user_id),
  prompt_id      INTEGER NOT NULL REFERENCES prompts(prompt_id),
  name           TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  archived_at    TEXT,
  UNIQUE (user_id, prompt_id)
);
CREATE INDEX ix_watchlists_prompt ON watchlists(prompt_id);

CREATE TABLE runs (
  run_id              INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt_id           INTEGER NOT NULL REFERENCES prompts(prompt_id),
  as_of               TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('scheduled','catch_up','dry_run')),
  status              TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','blocked_stale_data')),
  applied_steps_json  TEXT CHECK (applied_steps_json IS NULL OR json_valid(applied_steps_json)),
  funnel_json         TEXT CHECK (funnel_json IS NULL OR json_valid(funnel_json)),
  data_snapshot_hash  TEXT,
  engine_version      TEXT,
  forward_record_ref  TEXT,
  started_at TEXT, finished_at TEXT, error TEXT
);
CREATE UNIQUE INDEX ux_runs_graded ON runs(prompt_id, as_of) WHERE kind <> 'dry_run';

CREATE TABLE symbols (
  symbol   TEXT PRIMARY KEY,
  name     TEXT, sector TEXT, isin TEXT UNIQUE,
  active   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE run_results (
  run_id            INTEGER NOT NULL REFERENCES runs(run_id),
  symbol            TEXT NOT NULL REFERENCES symbols(symbol),
  membership        TEXT NOT NULL CHECK (membership IN ('full_match','near_miss','rejected_risk_cap')),
  in_forward_record INTEGER NOT NULL DEFAULT 0 CHECK (in_forward_record IN (0,1)),
  failed_conds_json TEXT CHECK (failed_conds_json IS NULL OR json_valid(failed_conds_json)),
  cond_json         TEXT NOT NULL CHECK (json_valid(cond_json)),
  metrics_json      TEXT CHECK (metrics_json IS NULL OR json_valid(metrics_json)),
  ep REAL, sl REAL, ref_price REAL, confidence REAL,
  window_offset INTEGER, days_since_flip INTEGER,
  entry_status      TEXT CHECK (entry_status IN ('pending_selection','entered','not_confirmed','no_point_data','watching')),
  PRIMARY KEY (run_id, symbol),
  CHECK (in_forward_record = 0 OR membership = 'full_match')
);
CREATE INDEX ix_results_membership ON run_results(run_id, membership);

CREATE TABLE watchlist_entries (
  entry_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  watchlist_id   INTEGER NOT NULL REFERENCES watchlists(watchlist_id),
  symbol         TEXT NOT NULL REFERENCES symbols(symbol),
  first_run_id   INTEGER NOT NULL REFERENCES runs(run_id),
  last_run_id    INTEGER NOT NULL REFERENCES runs(run_id),
  membership     TEXT NOT NULL CHECK (membership IN ('full_match','near_miss','rejected_risk_cap')),
  status         TEXT NOT NULL CHECK (status IN ('pending_selection','entered','not_confirmed',
                   'no_point_data','watching','dropped_from_screen','stopped_out','removed_by_user','closed')),
  entry_date TEXT, entry_price REAL, stop REAL,
  ref_price      REAL,
  user_note      TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (watchlist_id, symbol, first_run_id),
  CHECK (membership = 'full_match' OR entry_price IS NULL)
);
CREATE INDEX ix_entries_list ON watchlist_entries(watchlist_id, status, membership);
CREATE UNIQUE INDEX ux_entries_open ON watchlist_entries(watchlist_id, symbol)
  WHERE status NOT IN ('dropped_from_screen','stopped_out','removed_by_user','closed');
