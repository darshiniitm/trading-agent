-- Supabase Auth identity link (docs/login-auth-plan.md §3.4). Passwords now live in Supabase; the local
-- password_hash column and the HMAC session cookie are retired. user_id stays the numeric, user-visible id.
ALTER TABLE users ADD COLUMN auth_user_id TEXT;
ALTER TABLE users ADD COLUMN last_login_at TEXT;
CREATE UNIQUE INDEX users_auth_user_id_uq ON users(auth_user_id) WHERE auth_user_id IS NOT NULL;
CREATE UNIQUE INDEX users_email_nocase_uq ON users(lower(email)) WHERE email IS NOT NULL;
ALTER TABLE users DROP COLUMN password_hash;

CREATE TABLE signup_allowlist (
  email       TEXT PRIMARY KEY COLLATE NOCASE,
  invited_by  INTEGER REFERENCES users(user_id),
  created_at  TEXT NOT NULL
);

-- Append-only audit trail.
CREATE TABLE auth_events (
  event_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(user_id),
  email       TEXT,
  event       TEXT NOT NULL CHECK (event IN ('login','logout','link','signup','denied','password_reset')),
  provider    TEXT,
  ip          TEXT,
  user_agent  TEXT,
  at          TEXT NOT NULL
);
CREATE TRIGGER auth_events_no_update BEFORE UPDATE ON auth_events BEGIN SELECT RAISE(ABORT, 'auth_events is append-only'); END;
CREATE TRIGGER auth_events_no_delete BEFORE DELETE ON auth_events BEGIN SELECT RAISE(ABORT, 'auth_events is append-only'); END;
