-- apps/web/src/server/db/migrations/0004_compiler.sql
PRAGMA foreign_keys = ON;

ALTER TABLE prompt_drafts ADD COLUMN source_phrases_json TEXT CHECK (source_phrases_json IS NULL OR json_valid(source_phrases_json));
ALTER TABLE prompt_drafts ADD COLUMN unsupported_json TEXT CHECK (unsupported_json IS NULL OR json_valid(unsupported_json));

CREATE TABLE compilations (
  compilation_id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id       INTEGER NOT NULL REFERENCES prompt_drafts(draft_id),
  model          TEXT NOT NULL,
  raw_json       TEXT NOT NULL CHECK (json_valid(raw_json)),
  errors_json    TEXT CHECK (errors_json IS NULL OR json_valid(errors_json)),
  created_at     TEXT NOT NULL
);
