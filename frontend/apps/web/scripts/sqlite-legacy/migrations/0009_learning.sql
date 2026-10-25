-- Interpreter learning loop (docs/prompt-agent-interpreter-plan.md §6): every edit a user makes to the
-- interpretation, alias proposals for the knowledge repository (reviewed by a person before use), and the
-- few-shot store of accepted prompts the Reader is shown.
CREATE TABLE IF NOT EXISTS interpreter_edit (
  edit_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(user_id),
  draft_id      INTEGER,
  phrase        TEXT NOT NULL,              -- the words the user wrote
  compiled_json TEXT NOT NULL CHECK (json_valid(compiled_json)),   -- what they compiled to
  edited_json   TEXT NOT NULL CHECK (json_valid(edited_json)),     -- what the user changed it to
  path          TEXT,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kb_alias_proposal (
  proposal_id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_kind  TEXT NOT NULL,
  entry_id    TEXT NOT NULL,
  alias       TEXT NOT NULL,
  seen        INTEGER NOT NULL DEFAULT 1,
  status      TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','accepted','rejected')),
  created_at  TEXT NOT NULL,
  UNIQUE (entry_kind, entry_id, alias)
);
CREATE TABLE IF NOT EXISTS interpreter_example (
  example_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(user_id),
  prompt_text     TEXT NOT NULL,
  conditions_json TEXT NOT NULL CHECK (json_valid(conditions_json)),
  golden_ok       INTEGER NOT NULL DEFAULT 0,   -- the user agreed this prompt may join the golden test set
  accepted_at     TEXT NOT NULL,
  UNIQUE (user_id, prompt_text)
);
