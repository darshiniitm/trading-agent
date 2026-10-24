-- Supabase Auth identity link (docs/login-auth-plan.md §3.4). user_id stays the numeric, user-visible id;
-- the auth.users uuid never appears in URLs or UI.
create extension if not exists citext;

alter table screener_app.users
  add column auth_user_id  uuid unique,
  add column email         citext unique,
  add column role          text not null default 'member' check (role in ('owner','member')),
  add column status        text not null default 'active' check (status in ('active','disabled')),
  add column last_login_at timestamptz;

-- auth.users only exists on Supabase; a plain Postgres (CI, local) keeps the column without the FK.
do $$ begin
  if to_regclass('auth.users') is not null then
    alter table screener_app.users add constraint users_auth_user_id_fkey
      foreign key (auth_user_id) references auth.users(id) on delete set null;
  end if;
end $$;

create table screener_app.signup_allowlist (
  email      citext primary key,
  invited_by bigint references screener_app.users,
  created_at timestamptz not null default now()
);

-- Append-only audit trail.
create table screener_app.auth_events (
  event_id   bigint generated always as identity primary key,
  user_id    bigint references screener_app.users,
  email      citext,
  event      text not null check (event in ('login','logout','link','signup','denied','password_reset')),
  provider   text,
  ip         inet,
  user_agent text,
  at         timestamptz not null default now()
);
create function screener_app.auth_events_immutable() returns trigger language plpgsql as
  $$ begin raise exception 'auth_events is append-only'; end $$;
create trigger auth_events_no_update_delete before update or delete on screener_app.auth_events
  for each row execute function screener_app.auth_events_immutable();
