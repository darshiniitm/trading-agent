-- ScreenProgram v5 draft state, written only server-side by the prompt compiler (never by a client PATCH).
ALTER TABLE prompt_drafts ADD COLUMN program_json TEXT CHECK (program_json IS NULL OR json_valid(program_json));
ALTER TABLE prompt_drafts ADD COLUMN program_clauses_json TEXT CHECK (program_clauses_json IS NULL OR json_valid(program_clauses_json));
ALTER TABLE prompt_drafts ADD COLUMN program_normalised TEXT;
