"""
Audit trail: the full evidence chain for the test.

  strategy input (rules.yaml)
    -> funnel: what got filtered out at each stage
      -> stocks selected (survivors, with the exact indicator values)
        -> trades chosen (EP / SL / R / target / confidence)
          -> realised return one week later

Emits a worked example for one week plus the complete 244-trade ledger.
"""
from __future__ import annotations

import json
import numpy as np
import pandas as pd

from src.screen.engine import run_screen
from src.trade.builder import build_trades
from src.backtest.harness import simulate_week_forward
from tests.offline import env, all_dates

pd.set_option("display.width", 200)


def worked_example(as_of_offset=-2):
    rule_spec, adapter, uni, panels, shares = env()
    dates = all_dates(panels)
    as_of = dates[as_of_offset]
    cost = rule_spec["validation"]["costs_pct_round_trip"] / 100

    res = run_screen(as_of, rule_spec, adapter, uni, panels, shares)
    trades = build_trades(res["survivors"], rule_spec)
    graded = simulate_week_forward(trades, panels, as_of, cost)

    nxt_date = min(d for d in dates if d > as_of)
    return dict(rule_spec=rule_spec, as_of=as_of, next_week=nxt_date,
                funnel=res["funnel"], survivors=res["survivors"],
                trades=trades, graded=graded, drop_log=res["drop_log"], panels=panels)


def main():
    ex = worked_example()
    as_of, nxt = ex["as_of"], ex["next_week"]
    rs = ex["rule_spec"]

    print("=" * 96)
    print("1. STRATEGY INPUT  (config/rules.yaml — this file IS the strategy)")
    print("=" * 96)
    u, sig, tr = rs["universe"], rs["signals"], rs["trade"]
    print(f"  Universe        : NSE, union of {u['index_lists']}")
    print(f"  Market cap band : Rs {u['market_cap_cr']['min']:,} cr  to  Rs {u['market_cap_cr']['max']:,} cr  (inclusive, PIT at as-of close)")
    print(f"  Liquidity       : median weekly turnover over {u['liquidity']['lookback_weeks']}w  >=  Rs {u['liquidity']['min']} cr")
    for s in sig:
        print(f"  Signal '{s['id']}'  : {s['indicator']}{tuple(v for k, v in s['params'].items() if isinstance(v, (int, float)))}  {s['params']['timeframe']}  ->  predicate:  {s['predicate']}")
    print(f"  Combine         : {rs['combine']}")
    print(f"  Entry (EP)      : {tr['entry']}")
    print(f"  Stop  (SL)      : {tr['stop']}")
    print(f"  Target          : EP + {tr['target_r_multiple']} x R      | reject if R/EP > {tr['max_r_pct']:.0%}")
    print(f"  Exit horizon    : {tr['exit_horizon']}   (SL hit intraweek -> stop, else week close)")
    print(f"  Costs           : {rs['validation']['costs_pct_round_trip']}% round trip")
    print(f"  Sector RS       : mode={rs['sector']['mode']} (highlight only, never eliminates)")

    print()
    print("=" * 96)
    print(f"2. FUNNEL — signal week {as_of.date()} (bar covering {as_of.date()} to Friday)")
    print("=" * 96)
    f = ex["funnel"]
    prev = None
    for _, r in f.iterrows():
        drop = "" if prev is None else f"   (-{prev - r['count']})"
        print(f"  {r['stage']:28s} {r['count']:6d}{drop}")
        prev = r["count"]

    reasons = {}
    for _, why in ex["drop_log"]:
        reasons[why] = reasons.get(why, 0) + 1
    print("\n  why stocks were dropped at the signal stage:")
    for why, n in sorted(reasons.items(), key=lambda x: -x[1]):
        print(f"    {why:42s} {n:5d}")

    print()
    print("=" * 96)
    print(f"3. STOCKS SELECTED — {len(ex['survivors'])} survivors as of {as_of.date()}")
    print("=" * 96)
    s = ex["survivors"].copy()
    if s.empty:
        print("  (none)")
    else:
        cols = ["ticker", "name", "sector", "mktcap_cr", "close", "vstop_line", "rsi",
                "flip_up", "median_weekly_turnover_cr"]
        show = s[[c for c in cols if c in s.columns]].copy()
        show["mktcap_cr"] = show["mktcap_cr"].round(0)
        show["close"] = show["close"].round(2)
        show["vstop_line"] = show["vstop_line"].round(2)
        show["rsi"] = show["rsi"].round(1)
        show["median_weekly_turnover_cr"] = show["median_weekly_turnover_cr"].round(1)
        show = show.rename(columns={"median_weekly_turnover_cr": "turnover_cr"})
        print(show.to_string(index=False))
        print("\n  Every row satisfies BOTH predicates: flip_up == True  AND  50 <= RSI <= 65")

    print()
    print("=" * 96)
    print("4. TRADES CHOSEN — EP / SL / R / target / confidence")
    print("=" * 96)
    t = ex["trades"].copy()
    if t.empty:
        print("  (none)")
    else:
        tt = t[["ticker", "EP", "SL", "R", "target", "RR", "confidence", "entry_status"]].copy()
        tt["R_pct"] = (tt["R"] / tt["EP"] * 100).round(2)
        for c in ("EP", "SL", "R", "target"):
            tt[c] = tt[c].round(2)
        print(tt.to_string(index=False))
        print("\n  NOTE: at screen time EP is a PLACEHOLDER (= signal-week close) because next")
        print("        week has not happened. R / target shown here are computed off that")
        print("        placeholder. The backtest replaces EP with the actual next-week open.")

    print()
    print("=" * 96)
    print(f"5. RETURN AFTER ONE WEEK — held {nxt.date()} week (buy Mon open, exit Fri close or SL)")
    print("=" * 96)
    g = ex["graded"].copy()
    if g.empty:
        print("  (no forward week available)")
    else:
        panels = ex["panels"]
        rows = []
        for _, r in g.iterrows():
            p = panels[r["ticker"]]
            nb = p[p["date"] == r["week_end"]].iloc[0]
            sig_close = float(p[p["date"] == as_of]["close"].iloc[0])
            rows.append({
                "ticker": r["ticker"],
                "sig_close": round(sig_close, 2),
                "EP(open)": round(float(r["EP"]), 2),
                "wk_low": round(float(nb["low"]), 2),
                "SL": round(float(r["SL"]), 2),
                "wk_close": round(float(nb["close"]), 2),
                "exit": r["exit_reason"],
                "exit_px": round(float(r["exit_price"]), 2),
                "ret%": round(float(r["ret_pct"]) * 100, 2),
                "net%": round(float(r["ret_pct_net"]) * 100, 2),
                "R_mult": round(float(r["r_multiple"]), 2),
                "conf": r["confidence"],
            })
        d = pd.DataFrame(rows)
        print(d.to_string(index=False))
        print(f"\n  Basket (equal weight): gross {d['ret%'].mean():+.2f}%   net {d['net%'].mean():+.2f}%   "
              f"winners {int((d['net%'] > 0).sum())}/{len(d)}")

    # ---------------- full ledger ----------------
    print()
    print("=" * 96)
    print("6. FULL LEDGER — all 104 folds")
    print("=" * 96)
    led = pd.read_parquet("/tmp/graded.parquet")
    out = led.copy()
    out["signal_week"] = pd.to_datetime(out["week_start"]).dt.date
    out["exit_week"] = pd.to_datetime(out["week_end"]).dt.date
    keep = ["signal_week", "exit_week", "ticker", "name", "sector", "mktcap_cr", "rsi",
            "close", "vstop_line", "EP", "SL", "target", "confidence",
            "exit_reason", "exit_price", "ret_pct", "ret_pct_net", "r_multiple"]
    out = out[[c for c in keep if c in out.columns]].sort_values(["signal_week", "ticker"])
    out.to_csv("/home/claude/poc/results_trade_ledger.csv", index=False)
    print(f"  {len(out)} trades written to results_trade_ledger.csv")
    print(f"\n  exit reason mix:")
    for k, v in out["exit_reason"].value_counts().items():
        sub = out[out["exit_reason"] == k]
        print(f"    {k:12s} {v:4d}  mean net {sub['ret_pct_net'].mean()*100:+.2f}%")
    print(f"\n  best 5 trades:")
    print(out.nlargest(5, "ret_pct_net")[["signal_week", "ticker", "EP", "exit_price", "ret_pct_net"]].to_string(index=False))
    print(f"\n  worst 5 trades:")
    print(out.nsmallest(5, "ret_pct_net")[["signal_week", "ticker", "EP", "exit_price", "ret_pct_net"]].to_string(index=False))

    # per-sector
    print(f"\n  by sector (net):")
    bs = out.groupby("sector")["ret_pct_net"].agg(["count", "mean"]).sort_values("mean")
    bs["mean"] = (bs["mean"] * 100).round(2)
    print(bs.to_string())

    # confidence buckets
    print(f"\n  by confidence bucket (net):")
    out["bucket"] = pd.qcut(out["confidence"], 4, duplicates="drop")
    cb = out.groupby("bucket", observed=True)["ret_pct_net"].agg(["count", "mean"])
    cb["mean"] = (cb["mean"] * 100).round(2)
    cb["hit_rate%"] = (out.groupby("bucket", observed=True)["ret_pct_net"].apply(lambda x: (x > 0).mean()) * 100).round(1)
    print(cb.to_string())

    # weekly basket returns
    wk = out.groupby("signal_week")["ret_pct_net"].agg(["count", "mean"]).reset_index()
    wk.columns = ["signal_week", "n_trades", "basket_net"]
    wk["basket_net"] = (wk["basket_net"] * 100).round(2)
    wk.to_csv("/home/claude/poc/results_weekly_baskets.csv", index=False)
    print(f"\n  {len(wk)} weekly baskets written to results_weekly_baskets.csv")
    print(f"  weeks positive: {(wk['basket_net'] > 0).sum()}/{len(wk)}")


if __name__ == "__main__":
    main()
