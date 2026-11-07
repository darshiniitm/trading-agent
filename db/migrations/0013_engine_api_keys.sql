-- Per-user API keys for the engine's public API (docs: Engine Production Plan, Phase 3).
-- Only a keyed hash (HMAC-SHA256 with the api_pepper secret) is stored; the key itself is shown once, at issue time.
-- Revoking sets revoked_at; the engine looks the key up on every request, so a revoked key gets 401 at once.
create table screener_app.engine_api_keys (
  key_id       text primary key,                 -- public, non-secret prefix of the key (ek_<key_id>_<secret>)
  label        text not null,                    -- who the key was issued to
  key_hash     text not null unique,
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz,
  last_used_at timestamptz
);
