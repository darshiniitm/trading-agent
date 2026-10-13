-- Prompt interpreter (docs/prompt-interpreter-spec.md): per-user saved defaults used to fill slots a prompt
-- leaves open, and the fully resolved 4-slot JSON stored with every prompt version so a run is reproducible.
CREATE TABLE IF NOT EXISTS user_defaults (
  user_id       INTEGER PRIMARY KEY REFERENCES users(user_id),
  defaults_json TEXT NOT NULL CHECK (json_valid(defaults_json)),
  updated_at    TEXT NOT NULL
);
ALTER TABLE prompts ADD COLUMN resolved_json TEXT CHECK (resolved_json IS NULL OR json_valid(resolved_json));
