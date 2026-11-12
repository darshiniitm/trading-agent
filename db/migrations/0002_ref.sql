create table ref.instruments (
  instrument_id bigint generated always as identity primary key,
  symbol        text not null unique,          -- as used by the code, e.g. 'HBLENGINE.NS'
  isin          text,
  name          text,
  exchange      text not null default 'NSE',
  series        text,
  listing_date  date,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

create table ref.sectors (
  sector_id  bigint generated always as identity primary key,
  sector     text not null,
  industry   text not null default '',
  source     text,
  created_at timestamptz not null default now(),
  unique (sector, industry)
);

create table ref.instrument_sector (
  instrument_id bigint not null references ref.instruments,
  sector_id     bigint not null references ref.sectors,
  valid_from    date not null default date '1900-01-01',
  valid_to      date,
  created_at    timestamptz not null default now(),
  primary key (instrument_id, valid_from)
);

create table ref.market_cap_snapshots (
  instrument_id bigint not null references ref.instruments,
  as_of         date not null,
  mcap_cr       numeric(14,2) not null,
  source        text,
  created_at    timestamptz not null default now(),
  primary key (instrument_id, as_of)
);

create table ref.trading_calendar (
  trade_date      date primary key,
  is_trading_day  boolean not null,
  week_id         text not null,               -- ISO week, e.g. '2026-W38'
  is_week_close   boolean not null default false,
  is_week_open    boolean not null default false,
  created_at      timestamptz not null default now()
);
create index on ref.trading_calendar (week_id);
