create table prompt_details.prompt_runs (
  prompt_run_id bigint generated always as identity primary key,
  prompt_id     bigint not null references app.prompts,
  prompt_text   text not null,
  final_answer  jsonb,
  watchlist_id  bigint references app.watchlists,
  status        text not null default 'running' check (status in ('running','succeeded','failed')),
  code_version  text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create index on prompt_details.prompt_runs (prompt_id);

create table prompt_details.agent_outputs (
  prompt_run_id bigint not null references prompt_details.prompt_runs on delete cascade,
  step_no       int not null,
  agent_name    text not null,
  input         jsonb,
  output        jsonb,
  model         text,
  duration_ms   int,
  error         text,
  created_at    timestamptz not null default now(),
  primary key (prompt_run_id, step_no)
);

-- ops.schema_migrations is bootstrapped by db/migrate.py
create table ops.ingestion_log (
  log_id        bigint generated always as identity primary key,
  job           text not null,
  source        text,
  rows_in       bigint,
  rows_upserted bigint,
  status        text not null default 'running',
  error         text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz
);
