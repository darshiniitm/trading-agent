from __future__ import annotations
import pandas as pd
import psycopg
from psycopg.types.json import Jsonb
from db.connect import db_url
from .base import Store, CANDIDATE_COLS


def _wk(d) -> str:
    y, w, _ = pd.Timestamp(d).isocalendar()
    return f"{y}-W{int(w):02d}"


class PostgresStore(Store):
    def __init__(self, url: str | None = None):
        self.url = url or db_url()

    def _q(self, sql, params=()):
        with psycopg.connect(self.url) as c:
            cur = c.execute(sql, params)
            cols = [d.name for d in cur.description]
            return pd.DataFrame(cur.fetchall(), columns=cols)

    def get_prices_daily(self, ticker, start=None, end=None):
        df = self._q("""select p.trade_date as date, p.open, p.high, p.low, p.close, p.volume
                        from market_data.daily_prices p join stock_master.stocks i using (instrument_id)
                        where i.symbol=%s and (%s::date is null or p.trade_date>=%s::date)
                          and (%s::date is null or p.trade_date<=%s::date) order by 1""",
                     (ticker, start, start, end, end))
        df["date"] = pd.to_datetime(df["date"])
        return df.astype({c: float for c in ("open", "high", "low", "close")})

    def get_candidates(self, arm, signal_date):
        df = self._q("""select i.symbol as ticker, c.candidate_class, c.reject_reason, c.conditions_met
                        from forward_testing.screen_candidates c join forward_testing.weekly_runs r using (run_id) join forward_testing.strategy_arms a using (arm_id)
                        join stock_master.stocks i using (instrument_id)
                        where a.arm_name=%s and r.signal_week_id = %s order by 1""", (arm, _wk(signal_date)))
        return df[CANDIDATE_COLS].reset_index(drop=True)

    def get_trades(self, arm, signal_date):
        df = self._q("""select i.symbol as ticker, t.stop_loss, t.exit_plan_price, t.confidence, t.r_pct, t.is_shadow,
                          o.return_pct_net as ret_pct_net_1w
                        from forward_testing.trades t join forward_testing.weekly_runs r using (run_id) join forward_testing.strategy_arms a using (arm_id)
                        join stock_master.stocks i using (instrument_id)
                        left join forward_testing.trade_outcomes o on o.trade_id=t.trade_id and o.horizon_weeks=1
                        where a.arm_name=%s and r.signal_week_id = %s order by 1""", (arm, _wk(signal_date)))
        return df.astype({c: float for c in ("stop_loss", "exit_plan_price", "confidence", "r_pct", "ret_pct_net_1w")},
                         errors="ignore").reset_index(drop=True)

    def get_watchlist(self, prompt_id):
        return self._q("select * from screener_app.v_watchlist_live where prompt_id=%s order by symbol", (prompt_id,))

    def save_run(self, arm, signal_date, candidates, params=None):
        with psycopg.connect(self.url) as c:
            arm_id = c.execute("select arm_id from forward_testing.strategy_arms where arm_name=%s", (arm,)).fetchone()
            if not arm_id:
                raise KeyError(f"unknown arm {arm!r}")
            wk = _wk(signal_date)
            if c.execute("select 1 from forward_testing.weekly_runs where arm_id=%s and signal_week_id=%s", (arm_id[0], wk)).fetchone():
                raise FileExistsError(f"run for {arm} {wk} already recorded (write-once)")
            run_id = c.execute("insert into forward_testing.weekly_runs (arm_id, signal_week_id, signal_date, params) values (%s,%s,%s,%s) "
                               "returning run_id", (arm_id[0], wk, (pd.Timestamp(signal_date) + pd.Timedelta(days=4)).date(),
                                                    Jsonb(params or {}))).fetchone()[0]
            for r in candidates.itertuples(index=False):
                iid = c.execute("select instrument_id from stock_master.stocks where symbol=%s", (r.ticker,)).fetchone()
                if not iid:
                    raise KeyError(f"unknown symbol {r.ticker}")
                c.execute("insert into forward_testing.screen_candidates (run_id, instrument_id, selected, candidate_class, reject_reason, "
                          "conditions_met) values (%s,%s,%s,%s,%s,%s)",
                          (run_id, iid[0], r.candidate_class == "selected", r.candidate_class, r.reject_reason,
                           None if pd.isna(r.conditions_met) else int(r.conditions_met)))
