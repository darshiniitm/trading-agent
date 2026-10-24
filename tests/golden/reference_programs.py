"""Hand-written ideal ScreenPrograms for the 20 golden prompts: what a correct compiler should emit.
They prove the ENGINE can reproduce each golden list (engine side), and are the target the compiler is diffed
against (compiler side). Dates/definitions follow the doc's "Defaults to confirm"."""
from __future__ import annotations


def ind(name, tf="1D", output=None, **params):
    d = {"ind": name, "params": params, "tf": tf}
    if output: d["output"] = output
    return d


def bar(src, tf="1D"):
    return ind("bar", tf, source=src)


def sma(n, tf="1D", src="close"): return ind("sma", tf, length=n, source=src)
def ema(n, tf="1D", src="close"): return ind("ema", tf, length=n, source=src)


def fld(name, **params):
    return {"field": name, "params": params}


def cond(cid, lhs, op, value=None, rhs=None, **kw):
    c = {"id": cid, "lhs": lhs, "op": op}
    if value is not None: c["value"] = value
    if rhs is not None: c["rhs"] = rhs
    c.update(kw)
    return c


def prog(universe, conds, actions=None, setdef=None, tf=None):
    ids = [c["id"] for c in conds]
    s = {"id": "S1", "from": "universe", "label": "qualified stocks", "eval": {"mode": "literal", "bar": "last_completed", **({"timeframe": tf} if tf else {})},
         "where": {"all": ids}}
    if setdef: s.update(setdef)
    return {"program_version": 5, "universe": universe, "sets": [s], "conditions": conds, "actions": actions or [],
            "source_phrases": [], "needs_input": [], "unsupported": [], "ignored": [], "unrecognised": [], "answers": []}


def idx(name): return {"source": "index", "index": name}


P = {}

P["TC01"] = prog(idx("NIFTY 500"), [
    cond("C1", bar("close"), ">", rhs=sma(150)), cond("C2", bar("close"), ">", rhs=sma(200)),
    cond("C3", sma(150), ">", rhs=sma(200)), cond("C4", sma(200), "up_over", bars=21),
    cond("C5", sma(50), ">", rhs=sma(150)), cond("C6", sma(50), ">", rhs=sma(200)), cond("C7", bar("close"), ">", rhs=sma(50)),
    cond("C8", bar("close"), ">=", rhs=ind("low_n", "1D", lookback=252), rhs_mult=1.30),
    cond("C9", bar("close"), ">=", rhs=ind("high_n", "1D", lookback=252), rhs_mult=0.75),
    cond("C10", fld("rs_rating", lookback=252), ">=", 70),
])
P["TC02"] = prog(idx("NIFTY 100"), [
    cond("C1", sma(50), "cross_above", rhs=sma(200), within_bars=10), cond("C2", sma(50), ">", rhs=sma(200))])
P["TC03"] = prog(idx("NIFTY 500"), [
    cond("C1", bar("close"), ">", rhs=ind("high_n", "1D", lookback=252, skip=1)),
    cond("C2", bar("volume"), ">=", rhs=ind("volume_avg", "1D", length=20, skip=1), rhs_mult=2)])
P["TC04"] = prog(idx("NIFTY 100"), [
    cond("C1", bar("close"), ">", rhs=sma(200)), cond("C2", ind("rsi", "1D", length=2), "<", 10)])
P["TC05"] = prog(idx("NIFTY 200"), [
    cond("C1", ind("supertrend", "1D", length=10, mult=3), "flip", dir="long", within_bars=3),
    cond("C2", ind("adx", "1D", length=14), ">", 25)])
P["TC06"] = prog(idx("NIFTY 200"), [
    cond("C1", ind("macd", "1D", output="value", fast=12, slow=26, signal=9, source="close"), "cross_above",
         rhs=ind("macd", "1D", output="signal", fast=12, slow=26, signal=9, source="close"), within_bars=2),
    cond("C2", ind("macd", "1D", output="value", fast=12, slow=26, signal=9, source="close"), "<", 0),
    cond("C3", ind("macd", "1D", output="value", fast=12, slow=26, signal=9, source="close"), ">",
         rhs=ind("macd", "1D", output="signal", fast=12, slow=26, signal=9, source="close"))])
P["TC07"] = prog(idx("NIFTY 500"), [
    cond("C1", ind("bb_squeeze", "1D", length=20, mult=2, lookback=126, within=5), "==", 1),
    cond("C2", bar("close"), ">", rhs=ind("bollinger", "1D", output="upper", length=20, mult=2, source="close"))])
P["TC08"] = prog(idx("NIFTY 200"), [
    cond("C1", ind("narrow_range", "1D", length=7), "==", 1), cond("C2", ind("inside_day", "1D"), "==", 1)])
P["TC09"] = prog(idx("NIFTY 200"), [
    cond("C1", ema(9), "cross_above", rhs=ema(21), within_bars=3), cond("C2", ema(9), ">", rhs=ema(21)),
    cond("C3", bar("close"), ">", rhs=ema(200))])
ich = lambda out: ind("ichimoku", "1D", output=out, tenkan=9, kijun=26, span_b=52, shift=26)
P["TC10"] = prog(idx("NIFTY 200"), [
    cond("C1", ich("tenkan"), "cross_above", rhs=ich("kijun"), within_bars=3), cond("C2", ich("tenkan"), ">", rhs=ich("kijun")),
    cond("C3", bar("close"), ">", rhs=ich("cloud_top"))])
rsi_w = lambda n=14: ind("rsi", "1W", length=n)
P["TC11"] = prog({"source": "nse_all"}, [
    cond("C1", fld("mcap_cr"), "between", [10000, 50000]),
    cond("C2", ind("vstop", "1W", length=10, mult=2, source="close"), "flip", dir="long"),
    cond("C3", rsi_w(), "between", [50, 65])], tf="1W")
P["TC12"] = prog(idx("NIFTY 200"), [cond("C1", ind("momentum_skip", "1D", lookback=252, skip=21), ">", -1000)],
                 actions=[{"id": "A1", "type": "rank", "set": "S1", "by": [{"key": "C1.value", "order": "desc"}]},
                          {"id": "A2", "type": "limit", "set": "S1", "n": 20}])
P["TC13"] = prog(idx("NIFTY 500"), [
    cond("C1", bar("close"), "<=", rhs=ind("low_n", "1D", lookback=252), rhs_mult=1.10),
    cond("C2", ind("rsi", "1D", length=14), "cross_above", 30, within_bars=3), cond("C3", ind("rsi", "1D", length=14), ">", 30)])
P["TC14"] = prog(idx("NIFTY 500"), [
    cond("C1", ind("gap_up", "1D"), ">=", 0.02), cond("C2", bar("close"), ">", rhs=bar("open")),
    cond("C3", bar("volume"), ">=", rhs=ind("volume_avg", "1D", length=20, skip=1), rhs_mult=1.5)])
P["TC15"] = prog(idx("NIFTY 500"), [
    cond("C1", bar("close", "1W"), ">", rhs=sma(30, "1W")), cond("C2", sma(30, "1W"), "up_over", bars=4),
    cond("C3", bar("close", "1W"), ">", rhs=ind("high_n", "1W", lookback=26, skip=1)),
    cond("C4", bar("volume", "1W"), ">=", rhs=ind("volume_avg", "1W", length=10, skip=1), rhs_mult=2)], tf="1W")
P["TC16"] = prog(idx("NIFTY 500"), [cond("C1", bar("close"), ">", 0)], actions=[
    {"id": "A1", "type": "group_by", "set": "S1", "key": "sector",
     "highlight": {"metric": "ew_sector_return_vs_universe", "lookback_sessions": 20, "top_n_per_group": 3, "rule": {}}}])
P["TC17"] = prog(idx("NIFTY 50"), [
    cond("C1", bar("close"), ">", rhs=ema(20)), cond("C2", bar("close"), ">", rhs=ema(50)), cond("C3", ind("rsi", "1D", length=14), ">", 55)],
    actions=[{"id": "A1", "type": "trade_plan", "set": "S1", "entry": {"at": "next_open"},
              "stop": {"from_atr": {"length": 14, "mult": 2}}, "target": {"r_multiple": 2}}])
P["TC18"] = prog(idx("NIFTY 200"), [
    cond("C1", ema(20), ">", rhs=ema(50)), cond("C2", ema(50), ">", rhs=ema(200)),
    cond("C3", bar("close"), ">=", rhs=ema(20)), cond("C4", bar("close"), "<=", rhs=ema(20), rhs_mult=1.02)])
P["TC19"] = prog({"source": "nse_all"}, [
    cond("C1", fld("mcap_cr"), "between", [10000, 50000]), cond("C2", ind("turnover_avg", "1D", length=20), ">=", 25),
    cond("C3", rsi_w(), ">", 60), cond("C4", bar("close", "1W"), ">", rhs=ema(20, "1W"))])
P["TC20"] = prog(idx("NIFTY 100"), [cond("C1", bar("close"), ">", rhs=sma(200))])
P["TC20"]["unsupported"] = [{"clause_id": "L1", "reason": "P/E and ROE have no data source"}]
