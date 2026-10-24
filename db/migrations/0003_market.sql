create table market.prices_daily (
  instrument_id bigint not null references ref.instruments,
  trade_date    date not null,
  open numeric(14,4), high numeric(14,4), low numeric(14,4), close numeric(14,4),
  adj_close numeric(14,4),
  volume        bigint,
  source        text,
  fetched_at    timestamptz,
  created_at    timestamptz not null default now(),
  primary key (instrument_id, trade_date)
);
create index on market.prices_daily (trade_date);

create table market.prices_weekly (
  instrument_id bigint not null references ref.instruments,
  week_id       text not null,
  week_start    date not null,                 -- first date of the bar (Monday-ish)
  open numeric(14,4), high numeric(14,4), low numeric(14,4), close numeric(14,4),
  volume        bigint,
  source        text,
  created_at    timestamptz not null default now(),
  primary key (instrument_id, week_id)
);
create index on market.prices_weekly (week_start);

create table market.indicator_defs (
  indicator_def_id bigint generated always as identity primary key,
  name         text not null,                  -- 'vstop', 'rsi'
  params       jsonb not null,
  impl_version text not null default 'pine_v6',
  created_at   timestamptz not null default now(),
  unique (name, params, impl_version)
);

create table market.indicators_weekly (
  instrument_id    bigint not null references ref.instruments,
  week_id          text not null,
  indicator_def_id bigint not null references market.indicator_defs,
  value            numeric(18,6),
  direction        smallint check (direction in (-1, 1)),
  flipped          boolean,
  extra            jsonb,
  created_at       timestamptz not null default now(),
  primary key (instrument_id, week_id, indicator_def_id)
);
create index on market.indicators_weekly (week_id, indicator_def_id);

create table market.quote_cache (
  instrument_id bigint primary key references ref.instruments,
  price         numeric(14,4) not null,
  as_of         timestamptz not null,
  source        text,
  created_at    timestamptz not null default now()
);
