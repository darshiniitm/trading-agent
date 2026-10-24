"""Laya probe: whole-prompt questions over the golden + paraphrase prompts.

Run from the trading-agent repo root:
    python3 -m venv .venv-laya && . .venv-laya/bin/activate
    pip install laya
    python3 scripts/laya_probe/laya_probe.py

Writes results/laya_probe/matrix.json (one row per prompt: Laya's answer, probability,
expected answer and pass/fail for every question) and prints a per-question accuracy table.
First run downloads the Laya checkpoint from Hugging Face (~1.7 GB).
"""
import json, os, re, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIX = ROOT / "frontend/apps/web/tests/v5/fixtures"
OUT = ROOT / "results/laya_probe"

# ---------------------------------------------------------------- questions (state = whole prompt)
Q = {
    "universe": {"type": "choice", "instructions": "Which group of Indian stocks does the strategy scan?",
        "criteria": {"nifty50": "Nifty 50 index stocks", "nifty100": "Nifty 100 index stocks",
                     "nifty200": "Nifty 200 index stocks", "nifty500": "Nifty 500 index stocks",
                     "all_by_mcap": "all NSE stocks filtered by a market capitalisation range, such as midcaps",
                     "not_stated": "no stock universe is mentioned"}},
    "timeframe": {"type": "choice", "instructions": "Which chart timeframe do the conditions use?",
        "criteria": {"daily": "daily candles, days or trading sessions",
                     "weekly": "weekly candles or weeks only",
                     "mixed": "a mix of daily and weekly conditions"}},
    "entry_signal": {"type": "noul", "instructions": "Does the strategy set technical or fundamental conditions a stock must meet to be selected?"},
    "ranking": {"type": "noul", "instructions": "Does the strategy rank stocks or ask for the top N?"},
    "grouping": {"type": "noul", "instructions": "Does the strategy group results by sector or industry?"},
    "trade_plan": {"type": "noul", "instructions": "Does the strategy specify an entry price, stop loss or target?"},
    "exit_rule": {"type": "noul", "instructions": "Does the strategy say when to exit or sell a position?"},
    "validation": {"type": "noul", "instructions": "Does the strategy ask to backtest or validate the results on earlier data?"},
    "uses_trend": {"type": "noul", "instructions": "Does the strategy use a moving average or trend indicator such as SMA, EMA, DMA, Supertrend, VStop or Ichimoku?"},
    "trend_indicator": {"type": "choice", "instructions": "Which trend indicator does the strategy use?",
        "criteria": {"moving_average": "a moving average: SMA, EMA, DMA, or an N-day or N-week average",
                     "supertrend": "Supertrend",
                     "vstop": "VStop, the volatility stop",
                     "ichimoku": "Ichimoku: Tenkan-sen, Kijun-sen or the cloud",
                     "none": "no trend indicator"}},
    "uses_momentum": {"type": "noul", "instructions": "Does the strategy use a momentum measure such as RSI, MACD, ADX, relative strength or past returns?"},
    "uses_volume": {"type": "noul", "instructions": "Does the strategy use trading volume or turnover?"},
    "uses_price_action": {"type": "noul", "instructions": "Does the strategy use price levels or patterns such as 52-week highs or lows, gaps, inside days or narrow-range days?"},
    "uses_volatility": {"type": "noul", "instructions": "Does the strategy use a volatility measure such as Bollinger Bands, band width or ATR?"},
    "uses_market_cap": {"type": "noul", "instructions": "Does the strategy filter by market capitalisation?"},
    "uses_fundamentals": {"type": "noul", "instructions": "Does the strategy use valuation or profitability ratios such as P/E or ROE?"},
    "recent_event": {"type": "noul", "instructions": "Does the strategy require something to have just happened in the last few sessions, such as a crossover, a flip, a breakout or a new high?"},
    "named_setup": {"type": "noul", "instructions": "Does the prompt name a known trading setup or trader's method, such as Minervini, Weinstein, Connors, NR7 or a Bollinger squeeze?"},
}

# ---------------------------------------------------------------- expected answers per golden case
Y, N = True, False
COLS = ["entry_signal", "ranking", "grouping", "trade_plan", "exit_rule", "validation",
        "uses_trend", "uses_momentum", "uses_volume", "uses_price_action", "uses_volatility",
        "uses_market_cap", "uses_fundamentals", "recent_event", "named_setup"]
#          universe      tf        ent rnk grp tp  ex  val trd mom vol pa  vlt mc  fun evt nam
GOLD = {
 "TC01": ("nifty500", "daily",   Y,  N,  N,  N,  N,  N,  Y,  Y,  N,  Y,  N,  N,  N,  N,  Y),
 "TC02": ("nifty100", "daily",   Y,  N,  N,  N,  N,  N,  Y,  N,  N,  N,  N,  N,  N,  Y,  N),
 "TC03": ("nifty500", "daily",   Y,  N,  N,  N,  N,  N,  N,  N,  Y,  Y,  N,  N,  N,  Y,  N),
 "TC04": ("nifty100", "daily",   Y,  N,  N,  N,  Y,  N,  Y,  Y,  N,  N,  N,  N,  N,  N,  Y),
 "TC05": ("nifty200", "daily",   Y,  N,  N,  N,  N,  N,  Y,  Y,  N,  N,  N,  N,  N,  Y,  N),
 "TC06": ("nifty200", "daily",   Y,  N,  N,  N,  N,  N,  N,  Y,  N,  N,  N,  N,  N,  Y,  N),
 "TC07": ("nifty500", "daily",   Y,  N,  N,  N,  N,  N,  N,  N,  N,  N,  Y,  N,  N,  Y,  Y),
 "TC08": ("nifty200", "daily",   Y,  N,  N,  N,  N,  N,  N,  N,  N,  Y,  N,  N,  N,  N,  Y),
 "TC09": ("nifty200", "daily",   Y,  N,  N,  N,  N,  N,  Y,  N,  N,  N,  N,  N,  N,  Y,  N),
 "TC10": ("nifty200", "daily",   Y,  N,  N,  N,  N,  N,  Y,  N,  N,  N,  N,  N,  N,  Y,  N),
 "TC11": ("all_by_mcap", "weekly", Y, N, N,  N,  N,  Y,  Y,  Y,  N,  N,  N,  Y,  N,  Y,  N),
 "TC12": ("nifty200", "daily",   N,  Y,  N,  N,  N,  N,  N,  Y,  N,  N,  N,  N,  N,  N,  N),
 "TC13": ("nifty500", "daily",   Y,  N,  N,  N,  N,  N,  N,  Y,  N,  Y,  N,  N,  N,  Y,  N),
 "TC14": ("nifty500", "daily",   Y,  N,  N,  N,  N,  N,  N,  N,  Y,  Y,  N,  N,  N,  Y,  N),
 "TC15": ("nifty500", "weekly",  Y,  N,  N,  N,  N,  N,  Y,  N,  Y,  Y,  N,  N,  N,  Y,  Y),
 "TC16": ("nifty500", "daily",   N,  Y,  Y,  N,  N,  N,  N,  Y,  N,  N,  N,  N,  N,  N,  N),
 "TC17": ("nifty50",  "daily",   Y,  N,  N,  Y,  N,  N,  Y,  Y,  N,  N,  Y,  N,  N,  N,  N),
 "TC18": ("nifty200", "daily",   Y,  N,  N,  N,  N,  N,  Y,  N,  N,  N,  N,  N,  N,  N,  N),
 "TC19": ("all_by_mcap", "mixed", Y, N,  N,  N,  N,  N,  Y,  Y,  Y,  N,  N,  Y,  N,  N,  N),
 "TC20": ("nifty100", "daily",   Y,  N,  N,  N,  N,  N,  Y,  N,  N,  N,  N,  N,  Y,  N,  N),
}
TREND = {"TC01": "moving_average", "TC02": "moving_average", "TC03": "none", "TC04": "moving_average",
         "TC05": "supertrend", "TC06": "none", "TC07": "none", "TC08": "none", "TC09": "moving_average",
         "TC10": "ichimoku", "TC11": "vstop", "TC12": "none", "TC13": "none", "TC14": "none",
         "TC15": "moving_average", "TC16": "none", "TC17": "moving_average", "TC18": "moving_average",
         "TC19": "moving_average", "TC20": "moving_average"}
NAMED = re.compile(r"minervini|weinstein|stage 2|connors|crabel|nr7|squeeze|golden cross", re.I)


def expected(case: str, text: str) -> dict:
    g = GOLD[case]
    e = {"universe": g[0], "timeframe": g[1]}
    e.update({c: g[2 + i] for i, c in enumerate(COLS)})
    e["trend_indicator"] = TREND[case]
    e["named_setup"] = bool(NAMED.search(text))  # paraphrases may drop or add a setup name
    return e


def load_prompts():
    rows = [("golden", k, v) for k, v in json.loads((ROOT / "tests/golden/prompts.json").read_text()).items()]
    for s in ("fresh", "blind"):
        for k, lst in json.loads((FIX / f"golden-trader-{s}.json").read_text()).items():
            rows += [(s, k, t) for t in lst]
    return rows


def main():
    import laya
    router = laya.Router()
    if os.environ.get("ONLY") == "structural":
        OUT.mkdir(parents=True, exist_ok=True)
        return run_structural(router, load_prompts())
    OUT.mkdir(parents=True, exist_ok=True)
    rows, t_all = [], []
    for i, (src, case, text) in enumerate(load_prompts()):
        exp = expected(case, text)
        t0 = time.perf_counter()
        r = router.predict(text, Q, model="english")
        dt = time.perf_counter() - t0
        t_all.append(dt)
        cells = {}
        for q, spec in Q.items():
            a = r["answers"][q]
            if spec["type"] == "choice":
                got, p = a["choice"], a.get("answer_confidence", max(a["probabilities"].values()))
            else:
                got, p = a["noul"] >= 0.5, a["noul"]
            cells[q] = {"got": got, "p": round(float(p), 3), "want": exp[q], "ok": got == exp[q]}
        rows.append({"id": f"{src}:{case}#{i}", "source": src, "case": case, "prompt": text,
                     "seconds": round(dt, 3), "cells": cells})
        print(f"{i+1:3d} {src:6s} {case} {sum(c['ok'] for c in cells.values())}/{len(cells)}  {dt:.2f}s", flush=True)
    (OUT / "matrix.json").write_text(json.dumps({"questions": Q, "rows": rows}, indent=1))
    print("\nper-question accuracy")
    for q in Q:
        ok = sum(r["cells"][q]["ok"] for r in rows)
        print(f"  {q:18s} {ok:3d}/{len(rows)}  {100*ok/len(rows):5.1f}%")
    total = sum(c["ok"] for r in rows for c in r["cells"].values())
    print(f"\noverall {total}/{len(rows)*len(Q)}  ({100*total/(len(rows)*len(Q)):.1f}%)")
    t_all.sort()
    print(f"latency per prompt ({len(Q)} questions, 1 call): median {t_all[len(t_all)//2]:.2f}s, max {t_all[-1]:.2f}s")
    run_structural(router, load_prompts())


# ---------------------------------------------------------------- structural indicator test
# Q1 counts the kinds of indicator; Q2 is asked repeatedly with the answers so far removed.
KINDS = {
    "moving_average": "a moving average: SMA, EMA, DMA, or an N-day or N-week average",
    "rsi": "RSI, the relative strength index",
    "macd": "MACD",
    "adx": "ADX",
    "supertrend": "Supertrend",
    "vstop": "VStop, the volatility stop",
    "ichimoku": "Ichimoku: Tenkan-sen, Kijun-sen or the cloud",
    "bollinger": "Bollinger Bands or band width",
    "atr": "ATR, the average true range",
    "volume": "trading volume, average volume or turnover",
    "high_low": "a 52-week or N-week high or low",
    "returns": "past returns, outperformance or RS rating",
    "candle": "a candle pattern: gap, inside day, narrow-range day, close above open",
}
COUNT_Q = {"count": {"type": "score", "instructions": "How many different kinds of indicator does the strategy use?",
    "criteria": ["no indicator", "one kind of indicator", "two kinds of indicator", "three kinds of indicator", "four or more kinds"]}}
EXP_KINDS = {
 "TC01": {"moving_average", "high_low", "returns"}, "TC02": {"moving_average"},
 "TC03": {"high_low", "volume"}, "TC04": {"moving_average", "rsi"}, "TC05": {"supertrend", "adx"},
 "TC06": {"macd"}, "TC07": {"bollinger"}, "TC08": {"candle"}, "TC09": {"moving_average"},
 "TC10": {"ichimoku"}, "TC11": {"vstop", "rsi"}, "TC12": {"returns"}, "TC13": {"high_low", "rsi"},
 "TC14": {"candle", "volume"}, "TC15": {"moving_average", "high_low", "volume"}, "TC16": {"returns"},
 "TC17": {"moving_average", "rsi", "atr"}, "TC18": {"moving_average"},
 "TC19": {"volume", "rsi", "moving_average"}, "TC20": {"moving_average"},
}


def structural(router, text, max_rounds=5):
    c = router.predict(text, COUNT_Q, model="english")["answers"]["count"]
    n = min(4, max(0, round(float(c["score"]))))
    found, trail = [], []
    for k in range(max_rounds):
        opts = {key: v for key, v in KINDS.items() if key not in found}
        opts["none"] = "no other indicator" if found else "no indicator"
        instr = "Which indicator does the strategy use?" if not found else \
            "Apart from " + ", ".join(found) + ", which other indicator does the strategy use?"
        a = router.predict(text, {"k": {"type": "choice", "instructions": instr, "criteria": opts}},
                           model="english")["answers"]["k"]
        p = a.get("answer_confidence", max(a["probabilities"].values()))
        trail.append((a["choice"], round(float(p), 3)))
        if a["choice"] == "none":
            break
        found.append(a["choice"])
    return n, round(float(c["score"]), 2), found, trail


def run_structural(router, prompts):
    rows = []
    for src, case, text in prompts:
        want = EXP_KINDS[case]
        n, raw, found, trail = structural(router, text)
        got = set(found)
        rows.append({"source": src, "case": case, "prompt": text, "want": sorted(want), "count_score": raw,
                     "count": n, "count_ok": n == len(want), "found": found, "trail": trail,
                     "exact": got == want, "tp": len(got & want), "fp": len(got - want), "fn": len(want - got),
                     "first_ok": bool(found) and found[0] in want})
    (OUT / "structural.json").write_text(json.dumps(rows, indent=1))
    def rep(name, rs):
        if not rs:
            return
        tp, fp, fn = sum(r["tp"] for r in rs), sum(r["fp"] for r in rs), sum(r["fn"] for r in rs)
        print(f"  {name:22s} n={len(rs):2d}  count right {sum(r['count_ok'] for r in rs):2d}  "
              f"exact set {sum(r['exact'] for r in rs):2d}  first pick right {sum(r['first_ok'] for r in rs):2d}  "
              f"precision {tp/max(1,tp+fp):.2f}  recall {tp/max(1,tp+fn):.2f}")
    print("\nstructural indicator test")
    rep("single indicator", [r for r in rows if len(EXP_KINDS[r["case"]]) == 1])
    rep("several indicators", [r for r in rows if len(EXP_KINDS[r["case"]]) > 1])
    rep("all", rows)
    for r in rows:
        if not r["exact"]:
            print(f"    x {r['case']} {r['source']:6s} want {r['want']} got {r['found']} count {r['count']} | {r['prompt'][:70]}")


if __name__ == "__main__":
    sys.exit(main())
