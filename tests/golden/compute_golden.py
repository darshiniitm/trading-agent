"""Golden answers for 20 real-world strategy prompts on real NSE data.

Data (frozen, from the trading-agent repo):
  data_cache_literal/daily_ohlcv_since_2024-01-01.parquet   (prices up to Fri 25 Sep 2026)
  data_cache_literal/shares_outstanding.json                 (market cap = close x shares / 1e7)
  data_cache/sector/sector_map.parquet                       (sector, Nifty 500 names only)
  data_cache/index_lists/<index>/2026-10-09.csv              (index membership, today's lists)

Screen date: Fri 4 Sep 2026 close. Trade-plan entry: Mon 7 Sep 2026 open.
Only ref_indicators.py is used for maths (independent of the app's engine).
Run: python3 compute_golden.py <path-to-trading-agent>
"""
import sys, json, os
import numpy as np, pandas as pd
from ref_indicators import (rsi, vstop, sma, weekly, ema, ema_skipna, atr, supertrend, adx, stdev_pop)

REPO = sys.argv[1] if len(sys.argv) > 1 else os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
AS_OF = pd.Timestamp("2026-09-04"); ENTRY = pd.Timestamp("2026-09-07")
BT_SIG = pd.Timestamp("2026-08-28"); BT_ENTRY = pd.Timestamp("2026-08-31")
BT_EXITS = {1: "2026-09-04", 2: "2026-09-11", 3: "2026-09-18"}
CR = 1e7

daily = pd.read_parquet(f"{REPO}/data_cache_literal/daily_ohlcv_since_2024-01-01.parquet")
daily = daily[daily.date <= "2026-09-25"]
shares = json.load(open(f"{REPO}/data_cache_literal/shares_outstanding.json"))
sector = pd.read_parquet(f"{REPO}/data_cache/sector/sector_map.parquet").set_index("ticker").sector.to_dict()
IDX = {n: sorted(pd.read_csv(f"{REPO}/data_cache/index_lists/{n}/2026-10-09.csv").Symbol.astype(str).str.strip() + ".NS")
       for n in ["nifty_50", "nifty_100", "nifty_200", "nifty_500"]}
have = set(daily.ticker)
for n in IDX: IDX[n] = [t for t in IDX[n] if t in have]

def mcap(t, date=AS_OF):
    x = P[t][0]
    if t not in shares or date not in x.index: return np.nan
    return x.close.loc[date] * shares[t] / CR

# ---------- per-ticker features (only tickers we need) ----------
need = set(IDX["nifty_500"])
last_close = daily[daily.date == AS_OF].set_index("ticker").close
for t, c in last_close.items():
    if t in shares and 9000 <= c * shares[t] / CR <= 55000: need.add(t)
P = {}
for t, x in daily[daily.ticker.isin(need)].groupby("ticker"):
    x = x.set_index("date").sort_index()[["open", "high", "low", "close", "volume"]]
    if AS_OF not in x.index or len(x) < 60: continue
    h, l, c, v = x.high.values, x.low.values, x.close.values, x.volume.values
    for n in (5, 20, 50, 150, 200): x[f"sma{n}"] = sma(c, n)
    for n in (9, 20, 21, 50, 200): x[f"ema{n}"] = ema(c, n)
    x["rsi14"] = rsi(c, 14); x["rsi2"] = rsi(c, 2)
    x["atr14"] = atr(h, l, c, 14)
    x["st"], x["st_dir"] = supertrend(h, l, c, 3.0, 10)
    x["adx"], _, _ = adx(h, l, c, 14)
    m = ema(c, 12) - ema(c, 26); x["macd"] = m; x["macd_sig"] = ema_skipna(m, 9)
    sd = stdev_pop(c, 20); x["bb_up"] = x.sma20 + 2 * sd; x["bb_lo"] = x.sma20 - 2 * sd
    x["bbw"] = (x.bb_up - x.bb_lo) / x.sma20
    x["hi252"] = x.high.rolling(252).max(); x["lo252"] = x.low.rolling(252).min()
    x["hi252_prev"] = x.high.shift(1).rolling(252).max()
    x["vol20_prev"] = x.volume.shift(1).rolling(20).mean()
    x["turn20_cr"] = (x.close * x.volume).rolling(20).mean() / CR
    w = weekly(x[["open", "high", "low", "close", "volume"]])
    st, up = vstop(w.high.values, w.low.values, w.close.values, 10, 2.0)
    w["vstop"] = st; w["up"] = up; w["flip_up"] = w.up & ~w.up.shift(1, fill_value=True)
    w["rsi14"] = rsi(w.close.values, 14); w["ema20"] = ema(w.close.values, 20); w["sma30"] = sma(w.close.values, 30)
    w["vol10_prev"] = w.volume.shift(1).rolling(10).mean(); w["hi26_prev"] = w.high.shift(1).rolling(26).max()
    P[t] = (x, w)

def D(t, k=0):            # daily row k sessions before AS_OF
    x = P[t][0]; i = x.index.get_loc(AS_OF); return x.iloc[i - k]
def Wk(t, date=AS_OF): return P[t][1].loc[date]
def r2(v): return None if v is None or pd.isna(v) else round(float(v), 2)
def U(name): return [t for t in IDX[name] if t in P]
def bare(t): return t.replace(".NS", "")

G = {"screen_date": str(AS_OF.date()), "entry_date": str(ENTRY.date()),
     "data_files": ["data_cache_literal/daily_ohlcv_since_2024-01-01.parquet",
                    "data_cache_literal/shares_outstanding.json", "data_cache/sector/sector_map.parquet",
                    "data_cache/index_lists/*/2026-10-09.csv"], "cases": {}}
def put(cid, tickers, universe, **extra):
    G["cases"][cid] = {"universe_size": len(universe), "count": len(tickers),
                       "expected_tickers": [bare(t) for t in tickers], **extra}

# TC01 Minervini trend template, Nifty 500
u = U("nifty_500")
ret252 = pd.Series({t: D(t).close / D(t, 252).close - 1 for t in u if len(P[t][0].loc[:AS_OF]) > 252})
rs = ret252.rank(pct=True) * 100
def tt(t):
    r, a = D(t), D(t, 21)
    return (t in rs.index and r.close > r.sma150 and r.close > r.sma200 and r.sma150 > r.sma200 and r.sma200 > a.sma200
            and r.sma50 > r.sma150 and r.sma50 > r.sma200 and r.close > r.sma50 and r.close >= 1.30 * r.lo252
            and r.close >= 0.75 * r.hi252 and rs[t] >= 70)
s = sorted(t for t in u if tt(t))
put("TC01", s, u, rows=[{"ticker": bare(t), "close": r2(D(t).close), "sma50": r2(D(t).sma50), "sma150": r2(D(t).sma150),
                          "sma200": r2(D(t).sma200), "pct_above_52w_low": r2((D(t).close / D(t).lo252 - 1) * 100),
                          "pct_below_52w_high": r2((1 - D(t).close / D(t).hi252) * 100), "rs_rank": r2(rs[t])} for t in s])

# TC02 Golden cross in last 10 sessions, Nifty 100
u = U("nifty_100"); rows = []
for t in u:
    x = P[t][0].loc[:AS_OF].tail(11)
    cr = (x.sma50 > x.sma200) & (x.sma50.shift(1) <= x.sma200.shift(1))
    cr = cr.iloc[1:]
    if cr.any() and D(t).sma50 > D(t).sma200:
        rows.append({"ticker": bare(t), "cross_date": str(cr[cr].index[-1].date()), "sma50": r2(D(t).sma50), "sma200": r2(D(t).sma200)})
rows.sort(key=lambda r: r["cross_date"], reverse=True)
put("TC02", [r["ticker"] + ".NS" for r in rows], u, rows=rows)

# TC03 New 52-week high on 2x volume, Nifty 500
u = U("nifty_500")
s = sorted(t for t in u if D(t).close > D(t).hi252_prev and D(t).volume >= 2 * D(t).vol20_prev)
put("TC03", s, u, rows=[{"ticker": bare(t), "close": r2(D(t).close), "prev_52w_high": r2(D(t).hi252_prev),
                          "vol_x_avg20": r2(D(t).volume / D(t).vol20_prev)} for t in s])

# TC04 Connors RSI(2), Nifty 100
u = U("nifty_100")
s = sorted(t for t in u if D(t).close > D(t).sma200 and D(t).rsi2 < 10)
put("TC04", s, u, rows=[{"ticker": bare(t), "close": r2(D(t).close), "sma200": r2(D(t).sma200), "rsi2": r2(D(t).rsi2),
                          "exit_level_sma5": r2(D(t).sma5)} for t in s])

# TC05 Supertrend(10,3) turned bullish in last 3 sessions + ADX(14) > 25, Nifty 200
u = U("nifty_200"); rows = []
for t in u:
    x = P[t][0].loc[:AS_OF].tail(4)
    turned = (x.st_dir == -1) & (x.st_dir.shift(1) == 1)
    turned = turned.iloc[1:]
    if turned.any() and D(t).st_dir == -1 and D(t).adx > 25:
        rows.append({"ticker": bare(t), "turn_date": str(turned[turned].index[-1].date()), "supertrend": r2(D(t).st), "adx": r2(D(t).adx)})
rows.sort(key=lambda r: r["ticker"])
put("TC05", [r["ticker"] + ".NS" for r in rows], u, rows=rows)

# TC06 MACD bullish crossover below zero in last 2 sessions, Nifty 200
u = U("nifty_200"); rows = []
for t in u:
    x = P[t][0].loc[:AS_OF].tail(3)
    cr = (x.macd > x.macd_sig) & (x.macd.shift(1) <= x.macd_sig.shift(1)); cr = cr.iloc[1:]
    if cr.any() and D(t).macd > D(t).macd_sig and D(t).macd < 0:
        rows.append({"ticker": bare(t), "cross_date": str(cr[cr].index[-1].date()), "macd": r2(D(t).macd), "signal": r2(D(t).macd_sig)})
rows.sort(key=lambda r: r["ticker"])
put("TC06", [r["ticker"] + ".NS" for r in rows], u, rows=rows)

# TC07 Bollinger squeeze breakout, Nifty 500
u = U("nifty_500"); rows = []
for t in u:
    x = P[t][0].loc[:AS_OF]
    low126 = x.bbw.rolling(126).min()
    sq = (x.bbw.tail(5) <= low126.tail(5) + 1e-12).any()
    if sq and D(t).close > D(t).bb_up:
        rows.append({"ticker": bare(t), "close": r2(D(t).close), "bb_upper": r2(D(t).bb_up), "bandwidth_pct": r2(D(t).bbw * 100)})
put("TC07", [r["ticker"] + ".NS" for r in rows], u, rows=rows)

# TC08 NR7 inside day, Nifty 200
u = U("nifty_200"); s = []
for t in u:
    x = P[t][0].loc[:AS_OF].tail(7); rng = x.high - x.low
    if rng.iloc[-1] < rng.iloc[:-1].min() and x.high.iloc[-1] < x.high.iloc[-2] and x.low.iloc[-1] > x.low.iloc[-2]:
        s.append(t)
put("TC08", sorted(s), u, rows=[{"ticker": bare(t), "high": r2(D(t).high), "low": r2(D(t).low), "range": r2(D(t).high - D(t).low),
                                 "buy_stop_above": r2(D(t).high), "sell_stop_below": r2(D(t).low)} for t in sorted(s)])

# TC09 EMA 9/21 crossover in last 3 sessions, above EMA 200, Nifty 200
u = U("nifty_200"); rows = []
for t in u:
    x = P[t][0].loc[:AS_OF].tail(4)
    cr = (x.ema9 > x.ema21) & (x.ema9.shift(1) <= x.ema21.shift(1)); cr = cr.iloc[1:]
    if cr.any() and D(t).ema9 > D(t).ema21 and D(t).close > D(t).ema200:
        rows.append({"ticker": bare(t), "cross_date": str(cr[cr].index[-1].date()), "ema9": r2(D(t).ema9), "ema21": r2(D(t).ema21), "ema200": r2(D(t).ema200)})
rows.sort(key=lambda r: r["ticker"])
put("TC09", [r["ticker"] + ".NS" for r in rows], u, rows=rows)

# TC10 / TC11 VStop brief (all NSE, 10K-50K cr), weekly
def band_at(date):
    out = []
    for t in P:
        x = P[t][0]
        if t in shares and date in x.index and 10000 <= x.close.loc[date] * shares[t] / CR <= 50000: out.append(t)
    return sorted(out)
def wk_ok(t, date): return date in P[t][1].index
band = band_at(AS_OF)
flips = [t for t in band if wk_ok(t, AS_OF) and Wk(t).flip_up]
qual = [t for t in flips if 50 <= Wk(t).rsi14 <= 65]
near = [t for t in flips if t not in qual]
# outperforming sectors: EW 4-week (20-session) return of band stocks per sector vs whole band
ret20 = pd.Series({t: D(t).close / D(t, 20).close - 1 for t in band}) * 100
secs = pd.Series({t: sector.get(t, "Unclassified") for t in band})
sec_ret = ret20.groupby(secs).mean(); bench = ret20.mean()
plans = [{"ticker": bare(t), "sector": sector.get(t, "Unclassified"), "weekly_close": r2(Wk(t).close), "weekly_rsi": r2(Wk(t).rsi14),
          "EP": r2(P[t][0].open.loc[ENTRY]), "SL": r2(Wk(t).vstop),
          "risk_pct": r2((P[t][0].open.loc[ENTRY] - Wk(t).vstop) / P[t][0].open.loc[ENTRY] * 100)} for t in qual]
put("TC10", qual, band, band_count=len(band), flipped=[bare(t) for t in flips],
    flipped_rsi_outside=[{"ticker": bare(t), "weekly_rsi": r2(Wk(t).rsi14)} for t in near],
    qualified_by_sector={k: sorted(bare(t) for t in qual if sector.get(t, "Unclassified") == k) for k in sorted({sector.get(t, "Unclassified") for t in qual})},
    band_ew_ret_4w_pct=r2(bench), sector_ew_ret_4w_pct={k: r2(v) for k, v in sec_ret.sort_values(ascending=False).items()},
    sector_counts={k: int(v) for k, v in secs.value_counts().items()},
    outperforming_sectors=sorted(k for k, v in sec_ret.items() if v > bench and k != "Unclassified"), plans=plans)
band_bt = band_at(BT_SIG)
q_bt = [t for t in band_bt if wk_ok(t, BT_SIG) and Wk(t, BT_SIG).flip_up and 50 <= Wk(t, BT_SIG).rsi14 <= 65]
bt = []
for t in q_bt:
    x = P[t][0]; ep = x.open.loc[BT_ENTRY]
    bt.append({"ticker": bare(t), "EP": r2(ep), **{f"ret_{k}w_pct": r2((x.close.loc[pd.Timestamp(d)] / ep - 1) * 100) for k, d in BT_EXITS.items()}})
put("TC11", q_bt, band_bt, signal_friday=str(BT_SIG.date()), entry=str(BT_ENTRY.date()), results=bt,
    avg={f"ret_{k}w_pct": r2(np.mean([b[f"ret_{k}w_pct"] for b in bt])) for k in BT_EXITS} if bt else None)

# TC12 12-1 momentum, Nifty 200 top 20
u = U("nifty_200")
mom = pd.Series({t: D(t, 21).close / D(t, 252).close - 1 for t in u if len(P[t][0].loc[:AS_OF]) > 252}) * 100
top = mom.sort_values(ascending=False).head(20)
put("TC12", list(top.index), u, ranked=[{"rank": i + 1, "ticker": bare(t), "ret_12_1_pct": r2(v)} for i, (t, v) in enumerate(top.items())],
    next_two=[{"ticker": bare(t), "ret_12_1_pct": r2(v)} for t, v in mom.sort_values(ascending=False).iloc[20:22].items()])

# TC13 Near 52-week low, RSI(14) crossed back above 30 in last 3 sessions, Nifty 500
u = U("nifty_500"); rows = []
for t in u:
    x = P[t][0].loc[:AS_OF].tail(4)
    cr = (x.rsi14 > 30) & (x.rsi14.shift(1) <= 30); cr = cr.iloc[1:]
    if cr.any() and D(t).rsi14 > 30 and D(t).close <= 1.10 * D(t).lo252:
        rows.append({"ticker": bare(t), "cross_date": str(cr[cr].index[-1].date()), "rsi14": r2(D(t).rsi14),
                     "pct_above_52w_low": r2((D(t).close / D(t).lo252 - 1) * 100)})
rows.sort(key=lambda r: r["ticker"])
put("TC13", [r["ticker"] + ".NS" for r in rows], u, rows=rows)

# TC14 Gap-up with volume, Nifty 500
u = U("nifty_500")
s = sorted(t for t in u if D(t).open >= 1.02 * D(t, 1).high and D(t).close > D(t).open and D(t).volume >= 1.5 * D(t).vol20_prev)
put("TC14", s, u, rows=[{"ticker": bare(t), "open": r2(D(t).open), "prev_high": r2(D(t, 1).high), "gap_pct": r2((D(t).open / D(t, 1).high - 1) * 100),
                          "close": r2(D(t).close), "vol_x_avg20": r2(D(t).volume / D(t).vol20_prev)} for t in s])

# TC15 Weinstein stage-2 breakout, weekly, Nifty 500
u = U("nifty_500"); rows = []
for t in u:
    w = P[t][1]
    if AS_OF not in w.index: continue
    i = w.index.get_loc(AS_OF); r = w.iloc[i]
    if i < 4: continue
    if r.close > r.sma30 and r.sma30 > w.sma30.iloc[i - 4] and r.close > r.hi26_prev and r.volume >= 2 * r.vol10_prev:
        rows.append({"ticker": bare(t), "weekly_close": r2(r.close), "sma30w": r2(r.sma30), "prior_26w_high": r2(r.hi26_prev),
                     "vol_x_avg10w": r2(r.volume / r.vol10_prev)})
put("TC15", [r["ticker"] + ".NS" for r in rows], u, rows=rows)

# TC16 Sector rotation, Nifty 500
u = U("nifty_500")
r20 = pd.Series({t: D(t).close / D(t, 20).close - 1 for t in u}) * 100
sec = pd.Series({t: sector.get(t, "Unclassified") for t in u})
sr = r20.groupby(sec).mean().sort_values(ascending=False); b = r20.mean()
out = [k for k, v in sr.items() if v > b and k != "Unclassified"]
G["cases"]["TC16"] = {"universe_size": len(u), "benchmark_ew_ret_4w_pct": r2(b),
    "sector_table": [{"sector": k, "ew_ret_4w_pct": r2(v), "stocks": int((sec == k).sum()), "outperforming": bool(v > b)} for k, v in sr.items()],
    "outperforming_sectors": out,
    "top3_by_sector": {k: [{"ticker": bare(t), "ret_4w_pct": r2(r20[t])} for t in r20[sec == k].sort_values(ascending=False).head(3).index] for k in out}}

# TC17 ATR trade plan, Nifty 50
u = U("nifty_50")
s = sorted(t for t in u if D(t).close > D(t).ema20 and D(t).close > D(t).ema50 and D(t).rsi14 > 55)
pl = []
for t in s:
    ep = P[t][0].open.loc[ENTRY]; a = D(t).atr14; sl = ep - 2 * a
    pl.append({"ticker": bare(t), "EP": r2(ep), "ATR14": r2(a), "SL": r2(sl), "target": r2(ep + 2 * (ep - sl)), "risk_pct": r2(2 * a / ep * 100)})
put("TC17", s, u, plans=pl)

# TC18 Pullback to 20 EMA in strong uptrend, Nifty 200
u = U("nifty_200")
s = sorted(t for t in u if D(t).ema20 > D(t).ema50 > D(t).ema200 and 0 <= D(t).close / D(t).ema20 - 1 <= 0.02)
put("TC18", s, u, rows=[{"ticker": bare(t), "close": r2(D(t).close), "ema20": r2(D(t).ema20), "ema50": r2(D(t).ema50), "ema200": r2(D(t).ema200),
                          "pct_above_ema20": r2((D(t).close / D(t).ema20 - 1) * 100)} for t in s])

# TC19 Mid-cap momentum with liquidity (all NSE)
s = sorted(t for t in band if D(t).turn20_cr >= 25 and wk_ok(t, AS_OF) and Wk(t).rsi14 > 60 and Wk(t).close > Wk(t).ema20)
put("TC19", s, band, rows=[{"ticker": bare(t), "mcap_cr": r2(mcap(t)), "turnover20_cr": r2(D(t).turn20_cr), "weekly_rsi": r2(Wk(t).rsi14),
                             "weekly_close": r2(Wk(t).close), "ema20w": r2(Wk(t).ema20)} for t in s])

# TC20 Fundamentals + technical, Nifty 100
u = U("nifty_100")
s = sorted(t for t in u if D(t).close > D(t).sma200)
put("TC20", [], u, technical_only_pass=[bare(t) for t in s], technical_only_count=len(s),
    note="P/E and ROE have no data source: no stock may be shown as fully qualified")

json.dump(G, open("golden.json", "w"), indent=1)
for k, v in G["cases"].items():
    print(k, v.get("count", ""), v.get("expected_tickers", v.get("outperforming_sectors"))[:25] if isinstance(v.get("expected_tickers", v.get("outperforming_sectors")), list) else "")
