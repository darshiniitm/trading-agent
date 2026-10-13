-- Every compile attempt (pass or fail) now keeps its own row with the raw model text.
ALTER TABLE compilations ADD COLUMN attempt INTEGER;
