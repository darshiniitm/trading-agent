create table kb.parameters (
  parameter_key      text primary key,
  display_name       text not null,
  definition         text,
  default_params     jsonb,
  units              text,
  computable         boolean not null default false,
  implementation_ref text,
  created_at         timestamptz not null default now()
);
create table kb.parameter_aliases (
  alias         text primary key,
  parameter_key text not null references kb.parameters,
  created_at    timestamptz not null default now()
);
create table kb.parameter_sources (
  parameter_key text not null references kb.parameters,
  url           text not null,
  retrieved_at  timestamptz,
  primary key (parameter_key, url)
);

-- User-visible ids are numeric only.
create table app.users (
  user_id      bigint generated always as identity primary key,
  display_name text,
  legacy_id    text,
  created_at   timestamptz not null default now()
);
create table app.prompts (
  prompt_id    bigint generated always as identity primary key,
  user_id      bigint not null references app.users,
  raw_text     text not null,
  status       text not null default 'draft' check (status in ('draft','confirmed')),
  confirmed_at timestamptz,
  liquidity_floor_confirmed boolean not null default false,
  legacy_id    text,
  created_at   timestamptz not null default now()
);
create table app.prompt_conditions (
  condition_id  bigint generated always as identity primary key,
  prompt_id     bigint not null references app.prompts on delete cascade,
  ordinal       int not null,
  parameter_key text not null references kb.parameters,
  operator      text,
  value         jsonb,
  trigger_point text,
  data_range    text,
  rank_spec     text,
  origin        text not null default 'user' check (origin in ('user','suggested')),
  is_optional   boolean not null default false,
  accepted      boolean,
  created_at    timestamptz not null default now(),
  unique (prompt_id, ordinal)
);
