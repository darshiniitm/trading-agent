create table fwd.arms (
  arm_id      bigint generated always as identity primary key,
  arm_name    text not null unique,
  arm_type    text not null check (arm_type in ('control','test','threshold','prompt')),
  rule_config jsonb,
  is_frozen   boolean not null default false,
  status      text,
  graduation_gate jsonb,
  source_prompt_id bigint references app.prompts,
  created_at  timestamptz not null default now()
);

create table fwd.runs (
  run_id         bigint generated always as identity primary key,
  arm_id         bigint not null references fwd.arms,
  signal_week_id text not null,
  signal_date    date not null,                -- Friday close
  selection_point text not null default 'monday_open',
  entry_date     date,
  record_id      text,                         -- legacy id, e.g. 'fwd_2026-09-21'
  code_version   text,
  params         jsonb,
  status         text not null default 'recorded',
  started_at     timestamptz,
  finished_at    timestamptz,
  created_at     timestamptz not null default now(),
  unique (arm_id, signal_week_id)
);
create index on fwd.runs (signal_week_id);

create table fwd.candidates (
  run_id        bigint not null references fwd.runs on delete cascade,
  instrument_id bigint not null references ref.instruments,
  stage_reached text,
  qualified     boolean,
  selected      boolean not null default false,
  candidate_class text not null check (candidate_class in ('selected','shadow','near_miss','rejected')),
  reject_reason text,
  conditions_met int,
  snapshot      jsonb,
  created_at    timestamptz not null default now(),
  primary key (run_id, instrument_id)
);
create index on fwd.candidates (run_id, candidate_class);

create table fwd.condition_flags (
  run_id        bigint not null,
  instrument_id bigint not null,
  condition_key text not null,
  value         smallint not null check (value in (0,1)),
  primary key (run_id, instrument_id, condition_key),
  foreign key (run_id, instrument_id) references fwd.candidates on delete cascade
);

create table fwd.sector_summary (
  run_id   bigint not null references fwd.runs on delete cascade,
  sector_id bigint not null references ref.sectors,
  qualified_count int,
  sector_return_pct numeric(10,4),
  is_outperforming boolean,
  primary key (run_id, sector_id)
);

create table fwd.trades (
  trade_id      bigint generated always as identity primary key,
  run_id        bigint not null references fwd.runs on delete cascade,
  instrument_id bigint not null references ref.instruments,
  entry_date    date,
  entry_price   numeric(14,4),
  stop_loss     numeric(14,4),
  exit_plan_price numeric(14,4),
  confidence    numeric(10,4),
  r_value       numeric(14,4),
  r_pct         numeric(10,4),
  is_shadow     boolean not null default false,
  details       jsonb,
  created_at    timestamptz not null default now(),
  unique (run_id, instrument_id)
);
create index on fwd.trades (instrument_id, entry_date);

create table fwd.trade_outcomes (
  trade_id      bigint not null references fwd.trades on delete cascade,
  horizon_weeks smallint not null check (horizon_weeks between 1 and 52),
  exit_date     date,
  exit_price    numeric(14,4),
  return_pct    numeric(10,4),
  return_pct_net numeric(10,4),
  r_multiple    numeric(10,4),
  hit_sl        boolean,
  exit_reason   text,
  computed_at   timestamptz,
  primary key (trade_id, horizon_weeks)
);

create table fwd.experiment_metrics (
  arm_id         bigint not null references fwd.arms,
  signal_week_id text not null,
  metric         text not null,
  value          numeric(18,6),
  detail         jsonb,
  primary key (arm_id, signal_week_id, metric)
);

-- Watchlists reference runs, so they are created here (after fwd.runs).
create table app.watchlists (
  watchlist_id bigint generated always as identity primary key,
  prompt_id    bigint not null references app.prompts,
  run_id       bigint not null references fwd.runs,
  created_at   timestamptz not null default now(),
  unique (prompt_id, run_id)
);
create table app.watchlist_items (
  watchlist_id bigint not null references app.watchlists on delete cascade,
  instrument_id bigint not null references ref.instruments,
  candidate_class text,
  conditions_met int,
  conditions_total int,
  primary key (watchlist_id, instrument_id)
);
create index on app.prompts (user_id);
