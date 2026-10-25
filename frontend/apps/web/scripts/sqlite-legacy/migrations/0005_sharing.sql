PRAGMA foreign_keys = ON;

ALTER TABLE prompts ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','shared'));
ALTER TABLE prompts ADD COLUMN copied_from_prompt_id INTEGER REFERENCES prompts(prompt_id);
ALTER TABLE prompt_drafts ADD COLUMN copied_from_prompt_id INTEGER REFERENCES prompts(prompt_id);
