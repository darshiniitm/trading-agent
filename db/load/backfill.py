"""Idempotent backfill of existing file outputs into Postgres (plan §4).

    python -m db.load.backfill reference|prices|calendar|forward|flags|threshold|literal|all
    python -m db.load.backfill reconcile        # writes docs/migration-reconciliation.md

Every sub-command is re-runnable (INSERT ... ON CONFLICT) and logs to data_pipeline_log.ingestion_log.
Bulk data goes through COPY into a temp staging table, then an upsert into the target.
Symbols keep the code's own form ('HBLENGINE.NS'); unknown symbols are created, never dropped.
"""
from __future__ import annotations
import argparse, glob, io, json, re, sys
from datetime import date, datetime
from pathlib import Path
import numpy as np
import pandas as pd
import psycopg
from psycopg.types.json import Jsonb
from db.connect import db_url
from src.data.resample import daily_to_weekly

ROOT = Path(__file__).resolve().parents[2]
CACHE, LCACHE = ROOT / "data_cache", ROOT / "data_cache_literal"
RES = ROOT / "results"
FLAG_COLS = ["A01_vstop_flip_up", "A02_vstop_uptrend", "A03_rsi_in_band", "A04_risk_cap_ok",
             "B01_sector_rs_4w_pos", "B02_sector_top_k", "B03_sector_rs_13w_pos", "B04_volume_expansion",
             "B05_trend_quality_strong", "B06_rsi_sweetspot_core", "C01_risk_headroom_5pp",
             "C02_liquidity_2x", "C03_cap_band_central"]
CAPS = ["15", "17.5", "20", "22.5", "25", "30", "40", "50"]


# ------------------------------------------------------------------ helpers
def week_id(d) -> str:
    y, w, _ = pd.Timestamp(d).isocalendar()
    return f"{y}-W{int(w):02d}"


def clean(v):
    """numpy/pandas scalar -> plain python (NaN/NaT -> None)."""
    if v is None:
        return None
    if isinstance(v, (np.floating, float)):
        return None if np.isnan(v) else float(v)
    if isinstance(v, np.integer):
        return int(v)
    if isinstance(v, np.bool_):
        return bool(v)
    if v is pd.NaT or (isinstance(v, str) and v == "nan"):
        return None
    return v


class Job:
    def __init__(self, conn, name, source=""):
        self.conn, self.name = conn, name
        self.id = conn.execute("insert into data_pipeline_log.ingestion_log (job, source) values (%s,%s) returning log_id",
                               (name, source)).fetchone()[0]
        self.rows_in = self.rows_up = 0

    def done(self, status="ok", error=None):
        self.conn.execute("update data_pipeline_log.ingestion_log set rows_in=%s, rows_upserted=%s, status=%s, error=%s, "
                          "finished_at=now() where log_id=%s", (self.rows_in, self.rows_up, status, error, self.id))
        print(f"[{self.name}] in={self.rows_in} upserted={self.rows_up} {status}")


def copy_df(conn, df: pd.DataFrame, table: str):
    buf = io.StringIO()
    df.to_csv(buf, index=False, header=False, na_rep="\\N")
    buf.seek(0)
    with conn.cursor() as cur, cur.copy(f"copy {table} ({','.join(df.columns)}) from stdin with (format csv, null '\\N')") as cp:
        while chunk := buf.read(1 << 20):
            cp.write(chunk)


class Instruments:
    """symbol -> instrument_id, creating unknown symbols on demand (logged in `created`)."""
    def __init__(self, conn):
        self.conn = conn
        self.map = dict(conn.execute("select symbol, instrument_id from stock_master.stocks").fetchall())
        self.created: list[str] = []

    def get(self, symbol: str, name=None) -> int:
        if symbol not in self.map:
            self.map[symbol] = self.conn.execute(
                "insert into stock_master.stocks (symbol, name) values (%s,%s) on conflict (symbol) do update "
                "set name = coalesce(stock_master.stocks.name, excluded.name) returning instrument_id",
                (symbol, name)).fetchone()[0]
            self.created.append(symbol)
        return self.map[symbol]


def ns(sym: str) -> str:
    sym = sym.strip()
    return sym if sym.endswith(".NS") or sym.startswith("^") else f"{sym}.NS"


# ------------------------------------------------------------------ reference
def load_reference(conn):
    job = Job(conn, "reference", "equity_master + universe csvs + sector_map")
    em = sorted(glob.glob(str(CACHE / "equity_master" / "*.csv")))[-1]
    eq = pd.read_csv(em)
    eq.columns = [c.strip() for c in eq.columns]
    job.rows_in += len(eq)
    for r in eq.itertuples(index=False):
        listed = pd.to_datetime(r[3], format="%d-%b-%Y", errors="coerce")
        conn.execute(
            """insert into stock_master.stocks (symbol, isin, name, series, listing_date, exchange)
               values (%s,%s,%s,%s,%s,'NSE')
               on conflict (symbol) do update set isin=excluded.isin, name=excluded.name,
                 series=excluded.series, listing_date=excluded.listing_date""",
            (ns(r[0]), clean(r[6]), clean(r[1]), clean(r[2]), None if pd.isna(listed) else listed.date()))
    job.rows_up += len(eq)
    inst = Instruments(conn)

    # sectors: Industry from the index CSVs, sector from sector_map
    ind = {}
    for f in ("universe_nifty500.csv", "universe_midcap150.csv", "universe_smallcap250.csv"):
        p = CACHE / f
        if p.exists():
            u = pd.read_csv(p)
            ind.update({ns(s): i for s, i in zip(u["Symbol"], u["Industry"])})
    smap = pd.read_parquet(CACHE / "sector" / "sector_map.parquet")
    job.rows_in += len(smap)
    for t, sector in zip(smap["ticker"], smap["sector"]):
        if pd.isna(sector):
            continue
        sid = conn.execute(
            "insert into stock_master.sectors (sector, industry, source) values (%s,'', 'sector_map.parquet') "
            "on conflict (sector, industry) do update set source=stock_master.sectors.source returning sector_id",
            (sector,)).fetchone()[0]
        conn.execute(
            "insert into stock_master.stock_sector_history (instrument_id, sector_id) values (%s,%s) "
            "on conflict (instrument_id, valid_from) do update set sector_id=excluded.sector_id",
            (inst.get(t), sid))
        job.rows_up += 1
    job.done()


# ------------------------------------------------------------------ prices
def _price_sources(scope: str, since: str):
    """Priority order; first source wins per (ticker, date)."""
    frames = []
    for f in sorted(glob.glob(str(CACHE / "ohlcv" / "daily" / "*.parquet"))):
        frames.append(("data_cache/ohlcv/daily", f))
    for f in (CACHE / "daily_ohlcv_since_2019-01-01.parquet", LCACHE / "daily_ohlcv_since_2024-01-01.parquet",
              LCACHE / "daily_ohlcv_1820d.parquet", CACHE / "daily_ohlcv_1820d.parquet"):
        if f.exists():
            frames.append((f.parent.name + "/" + f.name, str(f)))
    return frames


def load_prices(conn, scope="universe", since="2019-01-01"):
    """scope=universe: full daily only for index-universe tickers (storage-friendly); weekly for all."""
    job = Job(conn, "prices", f"scope={scope} since={since}")
    inst = Instruments(conn)
    keep = None
    if scope == "universe":
        keep = set()
        for f in ("universe_nifty500.csv", "universe_midcap150.csv", "universe_smallcap250.csv"):
            if (CACHE / f).exists():
                keep |= {ns(s) for s in pd.read_csv(CACHE / f)["Symbol"]}
    seen_files: dict[str, list[pd.DataFrame]] = {}
    for src, path in _price_sources(scope, since):
        d = pd.read_parquet(path)
        d["source"] = src
        seen_files.setdefault("all", []).append(d)
    daily = pd.concat(seen_files["all"], ignore_index=True)
    daily["date"] = pd.to_datetime(daily["date"]).dt.normalize()
    daily = daily[daily["date"] >= since]
    job.rows_in = len(daily)
    daily = daily.drop_duplicates(["ticker", "date"], keep="first")        # priority = concat order
    if keep is not None:                       # storage-friendly scope applies to weekly bars too
        daily = daily[daily["ticker"].isin(keep)]
    weekly = daily_to_weekly(daily[["ticker", "date", "open", "high", "low", "close", "volume"]])
    wsrc = "resampled_from_daily"

    ids = {t: inst.get(t) for t in daily["ticker"].unique()}
    for name, df, key in (("daily", daily, 1),):
        out = pd.DataFrame({"instrument_id": df["ticker"].map(ids), "trade_date": df["date"].dt.date,
                            "open": df["open"].round(4), "high": df["high"].round(4), "low": df["low"].round(4),
                            "close": df["close"].round(4), "adj_close": np.nan,
                            "volume": df["volume"].round().astype("Int64"), "source": df["source"]})
        conn.execute("create temp table stg_daily (instrument_id bigint, trade_date date, open numeric, "
                     "high numeric, low numeric, close numeric, adj_close numeric, volume bigint, source text)")
        copy_df(conn, out, "stg_daily")
        n = conn.execute(
            """insert into market_data.daily_prices (instrument_id, trade_date, open, high, low, close, adj_close, volume, source, fetched_at)
               select instrument_id, trade_date, open, high, low, close, adj_close, volume, source, now() from stg_daily
               on conflict (instrument_id, trade_date) do update set open=excluded.open, high=excluded.high,
                 low=excluded.low, close=excluded.close, volume=excluded.volume, source=excluded.source""").rowcount
        conn.execute("drop table stg_daily")
        job.rows_up += n
    wk = pd.DataFrame({"instrument_id": weekly["ticker"].map(ids),
                       "week_id": weekly["date"].map(week_id), "week_start": weekly["date"].dt.date,
                       "open": weekly["open"].round(4), "high": weekly["high"].round(4), "low": weekly["low"].round(4),
                       "close": weekly["close"].round(4), "volume": weekly["volume"].round().astype("Int64"),
                       "source": wsrc})
    conn.execute("create temp table stg_weekly (instrument_id bigint, week_id text, week_start date, open numeric, "
                 "high numeric, low numeric, close numeric, volume bigint, source text)")
    copy_df(conn, wk, "stg_weekly")
    n = conn.execute(
        """insert into market_data.weekly_prices (instrument_id, week_id, week_start, open, high, low, close, volume, source)
           select * from stg_weekly on conflict (instrument_id, week_id) do update set week_start=excluded.week_start,
             open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, volume=excluded.volume,
             source=excluded.source""").rowcount
    conn.execute("drop table stg_weekly")
    job.rows_up += n
    job.done()


def load_calendar(conn):
    job = Job(conn, "calendar", "derived from market_data.daily_prices")
    rows = conn.execute("select trade_date from market_data.daily_prices group by trade_date "
                        "having count(*) >= 50 order by 1").fetchall()
    days = pd.DatetimeIndex([r[0] for r in rows])
    if days.empty:
        job.done("skipped", "no prices"); return
    allw = pd.bdate_range(days.min(), days.max())
    trading = set(days)
    df = pd.DataFrame({"trade_date": allw})
    df["is_trading_day"] = df["trade_date"].isin(trading)
    df["week_id"] = df["trade_date"].map(week_id)
    td = df[df["is_trading_day"]]
    df["is_week_open"] = df["trade_date"].isin(td.groupby("week_id")["trade_date"].min())
    df["is_week_close"] = df["trade_date"].isin(td.groupby("week_id")["trade_date"].max())
    job.rows_in = len(df)
    for r in df.itertuples(index=False):
        conn.execute(
            """insert into stock_master.trading_calendar (trade_date, is_trading_day, week_id, is_week_open, is_week_close)
               values (%s,%s,%s,%s,%s) on conflict (trade_date) do update set is_trading_day=excluded.is_trading_day,
               week_id=excluded.week_id, is_week_open=excluded.is_week_open, is_week_close=excluded.is_week_close""",
            (r.trade_date.date(), bool(r.is_trading_day), r.week_id, bool(r.is_week_open), bool(r.is_week_close)))
    job.rows_up = len(df)
    job.done()


# ------------------------------------------------------------------ forward-test arms
def upsert_arm(conn, name, typ, rule_config=None, frozen=False, status="forward"):
    return conn.execute(
        """insert into forward_testing.strategy_arms (arm_name, arm_type, rule_config, is_frozen, status) values (%s,%s,%s,%s,%s)
           on conflict (arm_name) do update set rule_config=coalesce(excluded.rule_config, forward_testing.strategy_arms.rule_config)
           returning arm_id""", (name, typ, Jsonb(rule_config) if rule_config else None, frozen, status)).fetchone()[0]


def upsert_run(conn, arm_id, signal_date, record_id=None, params=None, started=None, entry_date=None):
    sd = pd.Timestamp(signal_date)
    return conn.execute(
        """insert into forward_testing.weekly_runs (arm_id, signal_week_id, signal_date, entry_date, record_id, params, status, started_at)
           values (%s,%s,%s,%s,%s,%s,'recorded',%s)
           on conflict (arm_id, signal_week_id) do update set record_id=excluded.record_id, params=excluded.params
           returning run_id""",
        (arm_id, week_id(sd), (sd + pd.Timedelta(days=4)).date(), entry_date, record_id,
         Jsonb(params) if params is not None else None, started)).fetchone()[0]


def _cls(status: str, from_near_miss=False) -> str:
    s = (status or "").upper()
    if from_near_miss or s.startswith("NEAR_MISS"):
        return "near_miss"
    if s.startswith("SHADOW") or s.startswith("T1_EXTRA"):
        return "shadow"
    if s == "TRADE":
        return "selected"
    return "rejected"


def _load_picks_file(conn, inst, arm_id, path, with_trades=True):
    rec = json.loads(Path(path).read_text())
    wk_start = rec["signal_week_start"]
    run_id = upsert_run(conn, arm_id, wk_start, rec.get("record_id"),
                        {k: rec.get(k) for k in ("strategy", "exit_rule", "prior", "funnel", "benchmark_ticker",
                                                 "benchmark_close_at_signal", "n_survivors", "n_trades")},
                        rec.get("created_utc"))
    graded = (rec.get("graded") or {})
    gdetail = {g["ticker"]: g for g in graded.get("detail", [])}
    gdetail.update({g["ticker"]: g for g in graded.get("near_miss_detail", [])})
    n = 0
    for lst, nm in (("picks", False), ("near_miss", True)):
        for p in rec.get(lst, []):
            iid = inst.get(p["ticker"], p.get("name"))
            cls = _cls(p.get("status"), nm)
            conn.execute(
                """insert into forward_testing.screen_candidates (run_id, instrument_id, stage_reached, qualified, selected, candidate_class,
                     reject_reason, snapshot) values (%s,%s,%s,%s,%s,%s,%s,%s)
                   on conflict (run_id, instrument_id) do update set candidate_class=excluded.candidate_class,
                     selected=excluded.selected, snapshot=excluded.snapshot, reject_reason=excluded.reject_reason""",
                (run_id, iid, "rsi_band" if nm else "trade_builder", not nm, cls == "selected", cls,
                 p.get("status") if cls != "selected" else None, Jsonb({k: clean(v) for k, v in p.items()})))
            n += 1
            if with_trades and not nm:
                g = gdetail.get(p["ticker"], {})
                is_shadow = cls != "selected"
                ep = clean(g.get("EP_actual"))
                if ep is None and isinstance(p.get("EP"), (int, float)):
                    ep = clean(p["EP"])
                tid = conn.execute(
                    """insert into forward_testing.trades (run_id, instrument_id, entry_date, entry_price, stop_loss, exit_plan_price,
                         confidence, r_value, r_pct, is_shadow, details) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                       on conflict (run_id, instrument_id) do update set entry_price=excluded.entry_price,
                         details=excluded.details returning trade_id""",
                    (run_id, iid, rec.get("grade_after"), ep, clean(p.get("vstop_line_SL", p.get("SL"))),
                     clean(p.get("target_ref", p.get("target"))), clean(p.get("confidence")),
                     clean(p.get("R_ref", p.get("R"))), clean(p.get("R_pct_of_close")), is_shadow,
                     Jsonb({k: clean(v) for k, v in p.items()}))).fetchone()[0]
                if g and g.get("exit_price") is not None:
                    conn.execute(
                        """insert into forward_testing.trade_outcomes (trade_id, horizon_weeks, exit_date, exit_price, return_pct,
                             return_pct_net, r_multiple, hit_sl, exit_reason, computed_at)
                           values (%s,1,%s,%s,%s,%s,%s,%s,%s,%s)
                           on conflict (trade_id, horizon_weeks) do update set exit_price=excluded.exit_price,
                             return_pct=excluded.return_pct, return_pct_net=excluded.return_pct_net""",
                        (tid, g.get("exit_week"), clean(g.get("exit_price")), clean(g.get("ret_pct")),
                         clean(g.get("ret_pct_net")), clean(g.get("r_multiple")),
                         str(g.get("exit_reason", "")).startswith("stop"), g.get("exit_reason"), graded.get("graded_utc")))
    return n


def load_forward(conn, literal=False):
    base = RES / ("literal_test" if literal else "forward_test")
    job = Job(conn, "literal" if literal else "forward", str(base))
    inst = Instruments(conn)
    arm_files = {}
    for f in sorted(glob.glob(str(base / "picks_????-??-??.json"))):
        arm_files.setdefault("literal" if literal else "control", []).append(f)
    if not literal:
        for f in sorted(glob.glob(str(base / "picks_????-??-??_t1.json"))):
            arm_files.setdefault("T1", []).append(f)
    else:
        for f in sorted(glob.glob(str(base / "t1_picks_????-??-??.json"))):
            arm_files.setdefault("literal-T1", []).append(f)
    cfg = {"control": ROOT / "config/rules.yaml", "literal": ROOT / "config/rules_literal.yaml"}
    for arm, files in arm_files.items():
        rc = None
        if arm in cfg and cfg[arm].exists():
            import yaml; rc = yaml.safe_load(cfg[arm].read_text())
        arm_id = upsert_arm(conn, arm, "control" if arm in ("control", "literal") else "test", rc,
                            frozen=arm in ("control", "literal"))
        for f in files:
            job.rows_in += 1
            try:
                job.rows_up += _load_picks_file(conn, inst, arm_id, f, with_trades=arm != "T1" or True)
            except KeyError as e:
                print(f"  skip {Path(f).name}: missing {e}")
    job.done()
    if inst.created:
        print(f"  note: {len(inst.created)} symbols not in the equity master were created: {inst.created[:10]}")


# ------------------------------------------------------------------ flag matrix + thresholds
def load_flags(conn):
    job = Job(conn, "flags", str(RES / "feature_flags"))
    inst = Instruments(conn)
    arm_id = upsert_arm(conn, "flag-matrix", "test", None, frozen=True)
    for f in sorted(glob.glob(str(RES / "feature_flags" / "flags_????-??-??.csv"))):
        df = pd.read_csv(f)
        man = json.loads(Path(f.replace(".csv", ".manifest.json")).read_text())
        run_id = upsert_run(conn, arm_id, df["signal_week"].iloc[0], man.get("record_id"), man, man.get("created_utc"))
        job.rows_in += len(df)
        flag_rows = []
        for r in df.to_dict("records"):
            iid = inst.get(r["ticker"], r.get("name"))
            status = str(r.get("control_status") or "")
            cls = _cls(status) if status not in ("", "nan", "None") else "rejected"
            met = clean(r.get("flags_met"))
            snap = {k: clean(v) for k, v in r.items() if k not in FLAG_COLS}
            conn.execute(
                """insert into forward_testing.screen_candidates (run_id, instrument_id, stage_reached, qualified, selected, candidate_class,
                     reject_reason, conditions_met, snapshot) values (%s,%s,'eligible',%s,%s,%s,%s,%s,%s)
                   on conflict (run_id, instrument_id) do update set conditions_met=excluded.conditions_met,
                     snapshot=excluded.snapshot, candidate_class=excluded.candidate_class""",
                (run_id, iid, bool(r.get("A01_vstop_flip_up") == 1), bool(r.get("t4_selected") in (1, True)),
                 cls, status or None, None if met is None else int(met), Jsonb(snap)))
            for c in FLAG_COLS:
                v = clean(r.get(c))
                if v is not None:
                    flag_rows.append((run_id, iid, c, int(bool(v))))
        with conn.cursor() as cur:
            cur.executemany("insert into forward_testing.candidate_condition_flags values (%s,%s,%s,%s) on conflict do nothing", flag_rows)
        job.rows_up += len(flag_rows)
        conn.commit()
    job.done()


def load_threshold(conn):
    job = Job(conn, "threshold", str(RES / "threshold_experiment"))
    inst = Instruments(conn)
    arms = {c: upsert_arm(conn, f"threshold-experiment_{c}", "threshold", {"max_r_pct": float(c)}, frozen=True)
            for c in CAPS}
    for f in sorted(glob.glob(str(RES / "threshold_experiment" / "threshold_????-??-??.csv"))):
        df = pd.read_csv(f)
        wk = re.search(r"(\d{4}-\d{2}-\d{2})", f).group(1)
        rec = json.loads(Path(f.replace(".csv", ".json")).read_text())
        job.rows_in += len(df)
        for c, arm_id in arms.items():
            run_id = upsert_run(conn, arm_id, wk, rec.get("record_id"), {"max_r_pct": float(c)}, rec.get("created_utc"))
            for r in df.to_dict("records"):
                s = str(r.get(f"threshold-experiment_{c}"))
                cls = "selected" if s == "SELECTED" else "rejected"
                conn.execute(
                    """insert into forward_testing.screen_candidates (run_id, instrument_id, stage_reached, qualified, selected,
                         candidate_class, reject_reason, snapshot) values (%s,%s,'risk_cap',true,%s,%s,%s,%s)
                       on conflict (run_id, instrument_id) do update set selected=excluded.selected,
                         candidate_class=excluded.candidate_class""",
                    (run_id, inst.get(r["ticker"], r.get("name")), cls == "selected", cls,
                     None if cls == "selected" else s, Jsonb({k: clean(v) for k, v in r.items()})))
                job.rows_up += 1
        conn.commit()
    ledger = RES / "threshold_experiment" / "threshold_ledger.csv"
    if ledger.exists():
        L = pd.read_csv(ledger)
        for r in L.to_dict("records"):
            arm_id = arms.get(f"{r['cap_pct']:g}")
            if not arm_id:
                continue
            for m in ("selected_n", "selected_basket_net_pct", "selected_winners", "selected_worst_trade_pct",
                      "rejected_n", "rejected_basket_net_pct", "rejected_winners", "rejected_worst_trade_pct",
                      "selected_minus_control_pct", "selected_minus_rejected_pct", "benchmark_week_pct"):
                v = clean(r.get(m))
                if v is not None:
                    conn.execute(
                        """insert into forward_testing.experiment_metrics (arm_id, signal_week_id, metric, value, detail)
                           values (%s,%s,%s,%s,%s) on conflict (arm_id, signal_week_id, metric)
                           do update set value=excluded.value""",
                        (arm_id, week_id(r["signal_week"]), m, v, Jsonb({"recording_mode": r.get("recording_mode")})))
                    job.rows_up += 1
    job.done()


# ------------------------------------------------------------------ reconciliation
def reconcile(conn) -> str:
    out = ["# Migration reconciliation", f"\nGenerated {datetime.now():%Y-%m-%d %H:%M}. Any ✗ blocks cutover.\n",
           "| Check | Source (files) | Target (Postgres) | Match |", "|---|---|---|---|"]

    def row(name, src, tgt):
        out.append(f"| {name} | {src} | {tgt} | {'✓' if src == tgt else '✗'} |")

    em = pd.read_csv(sorted(glob.glob(str(CACHE / "equity_master" / "*.csv")))[-1])
    row("equity master symbols (≤ instruments)", len(em), conn.execute(
        "select count(*) from stock_master.stocks where isin is not null").fetchone()[0])
    keep = set()
    for f in ("universe_nifty500.csv", "universe_midcap150.csv", "universe_smallcap250.csv"):
        keep |= {ns(s) for s in pd.read_csv(CACHE / f)["Symbol"]}
    cnt, closes = conn.execute("select count(*), sum(close) from market_data.daily_prices").fetchone()
    out.append(f"| prices_daily rows / sum(close) | (see data_pipeline_log.ingestion_log) | {cnt} / {closes} | info |")
    for arm, pat in (("control", "forward_test/picks_????-??-??.json"), ("literal", "literal_test/picks_????-??-??.json")):
        files = glob.glob(str(RES / pat))
        src = sum(len(json.load(open(f)).get("picks", [])) + len(json.load(open(f)).get("near_miss", [])) for f in files)
        tgt = conn.execute("select count(*) from forward_testing.screen_candidates c join forward_testing.weekly_runs r using(run_id) join forward_testing.strategy_arms a "
                           "using(arm_id) where a.arm_name=%s", (arm,)).fetchone()[0]
        row(f"{arm} candidates (picks+near_miss)", src, tgt)
        row(f"{arm} runs", len(files), conn.execute(
            "select count(*) from forward_testing.weekly_runs r join forward_testing.strategy_arms a using(arm_id) where a.arm_name=%s", (arm,)).fetchone()[0])
    fl = glob.glob(str(RES / "feature_flags" / "flags_????-??-??.csv"))
    row("flag-matrix candidate rows", sum(len(pd.read_csv(f)) for f in fl), conn.execute(
        "select count(*) from forward_testing.screen_candidates c join forward_testing.weekly_runs r using(run_id) join forward_testing.strategy_arms a using(arm_id) "
        "where a.arm_name='flag-matrix'").fetchone()[0])
    th = glob.glob(str(RES / "threshold_experiment" / "threshold_????-??-??.csv"))
    row("threshold candidates (rows × 8 caps)", sum(len(pd.read_csv(f)) for f in th) * len(CAPS), conn.execute(
        "select count(*) from forward_testing.screen_candidates c join forward_testing.weekly_runs r using(run_id) join forward_testing.strategy_arms a using(arm_id) "
        "where a.arm_name like 'threshold-experiment_%'").fetchone()[0])
    text = "\n".join(out) + "\n"
    (ROOT / "docs" / "migration-reconciliation.md").write_text(text)
    print(text)
    return text


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["reference", "prices", "calendar", "forward", "flags", "threshold",
                                    "literal", "reconcile", "all"])
    ap.add_argument("--scope", choices=["universe", "all"], default="universe",
                    help="daily-bar scope (storage): index-universe tickers only, or every ticker")
    ap.add_argument("--since", default="2019-01-01")
    ap.add_argument("--url", default=None)
    a = ap.parse_args(argv)
    steps = {"reference": load_reference, "prices": lambda c: load_prices(c, a.scope, a.since),
             "calendar": load_calendar, "forward": load_forward, "flags": load_flags,
             "threshold": load_threshold, "literal": lambda c: load_forward(c, literal=True), "reconcile": reconcile}
    order = ["reference", "prices", "calendar", "forward", "literal", "flags", "threshold", "reconcile"]
    with psycopg.connect(a.url or db_url(), autocommit=False) as conn:
        for s in (order if a.cmd == "all" else [a.cmd]):
            steps[s](conn)
            conn.commit()


if __name__ == "__main__":
    main()
