-- P6 watchlist views (docs/watchlist-views-implementation-plan.md §4, SQLite mirror). Display-only data: nothing
-- here is read by runs, run_results, watchlist_entries, validations or any screening/selection/grading path.
ALTER TABLE symbols ADD COLUMN kind TEXT NOT NULL DEFAULT 'stock' CHECK (kind IN ('stock','index'));
ALTER TABLE symbols ADD COLUMN yahoo_ticker TEXT;

CREATE TABLE symbol_fundamentals (
  symbol        TEXT NOT NULL REFERENCES symbols(symbol),
  as_of         TEXT NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'INR',
  market_cap REAL, shares_out REAL, revenue_ttm REAL, eps_ttm REAL, dividend_ttm REAL,
  source        TEXT NOT NULL DEFAULT 'yfinance',
  fetched_at    TEXT NOT NULL,
  error         TEXT,
  PRIMARY KEY (symbol, as_of)
);

CREATE TABLE symbol_metrics (
  symbol        TEXT NOT NULL REFERENCES symbols(symbol),
  as_of         TEXT NOT NULL,
  timeframe     TEXT NOT NULL CHECK (timeframe IN ('1D','1W')),
  avg_vol_10 REAL,
  perf_1w REAL, perf_1m REAL, perf_3m REAL, perf_ytd REAL, perf_1y REAL, perf_5y REAL, perf_all REAL, first_close_date TEXT,
  beta_1y REAL, beta_3y REAL, beta_5y REAL, beta_benchmark TEXT,
  vol_1d REAL, vol_1w REAL, vol_1m REAL,
  rsi14 REAL, mom10 REAL, ao REAL, cci20 REAL,
  ma_rating REAL, os_rating REAL, tech_rating REAL,
  votes_json    TEXT CHECK (votes_json IS NULL OR json_valid(votes_json)),
  engine_version TEXT NOT NULL,
  computed_at   TEXT NOT NULL,
  PRIMARY KEY (symbol, as_of, timeframe)
);

CREATE TABLE user_benchmarks (
  user_id  INTEGER NOT NULL REFERENCES users(user_id),
  symbol   TEXT NOT NULL REFERENCES symbols(symbol),
  position INTEGER NOT NULL,
  PRIMARY KEY (user_id, symbol)
);

CREATE TABLE user_view_prefs (
  user_id        INTEGER NOT NULL REFERENCES users(user_id),
  watchlist_id   INTEGER NOT NULL REFERENCES watchlists(watchlist_id),
  view           TEXT NOT NULL DEFAULT 'screen' CHECK (view IN ('screen','price','financials','performance','risk','technicals')),
  hidden_columns TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(hidden_columns)),
  currency       TEXT NOT NULL DEFAULT 'INR' CHECK (currency IN ('INR','USD')),
  tech_timeframe TEXT NOT NULL DEFAULT '1D' CHECK (tech_timeframe IN ('1D','1W')),
  compact        INTEGER NOT NULL DEFAULT 0 CHECK (compact IN (0,1)),
  PRIMARY KEY (user_id, watchlist_id)
);

INSERT OR IGNORE INTO symbols (symbol, name, kind, yahoo_ticker, active) VALUES
  ('^NSEI', 'NIFTY 50', 'index', '^NSEI', 1),
  ('^NSEBANK', 'Nifty Bank', 'index', '^NSEBANK', 1),
  ('^BSESN', 'Sensex', 'index', '^BSESN', 1),
  ('^CNXIT', 'Nifty IT', 'index', '^CNXIT', 1),
  ('^GSPC', 'S&P 500', 'index', '^GSPC', 1);
