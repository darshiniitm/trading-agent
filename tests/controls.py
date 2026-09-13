"""
Control experiments — test plan section 8.3 / section 10.

Is the measured result a property of the STRATEGY, or of the market, or of a
broken harness? Only controls can tell these apart:

  1. benchmark          — what the market did over the same weeks
  2. universe average   — what a "buy everything eligible" book did
  3. random pick        — same trade count, same weeks, no signal
  4. shuffled returns   — signal on data whose structure has been destroyed
                          (null test: any surviving "edge" is a harness bug)
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from src.backtest.harness import rolling_walk_forward, summarize_trades, bootstrap_ci
from tests.offline import env, all_dates


def next_week_return(panel: pd.DataFrame, as_of: pd.Timestamp) -> float | None:
    """Same convention as the engine: buy next bar's open, sell that bar's close."""
    nxt = panel[panel["date"] > as_of].sort_values("date")
    if nxt.empty:
        return None
    row = nxt.iloc[0]
    o, c = float(row["open"]), float(row["close"])
    if not np.isfinite(o) or o <= 0:
        return None
    return (c - o) / o


def eligible_tickers(panels, shares, uni, rule_spec, as_of):
    """Universe that passed the cap band at as_of — the pool a random pick draws from."""
    CR = 1e7
    cap = rule_spec["universe"]["market_cap_cr"]
    out = []
    for t in uni["ticker"]:
        p = panels.get(t)
        if p is None:
            continue
        sl = p[p["date"] <= as_of]
        if sl.empty or t not in shares:
            continue
        mc = sl["close"].iloc[-1] * shares[t] / CR
        if cap["min"] <= mc <= cap["max"]:
            out.append(t)
    return out


def main():
    rule_spec, adapter, uni, panels, shares = env()
    dates = all_dates(panels)
    n_folds = rule_spec["validation"]["walk_forward_weeks"]
    fold_dates = dates[-(n_folds + 1):-1]
    cost = rule_spec["validation"]["costs_pct_round_trip"] / 100

    graded = pd.read_parquet("/tmp/graded.parquet")
    strat = graded["ret_pct"].to_numpy()                 # GROSS, to compare like-for-like
    picks_per_week = graded.groupby("week_start").size().to_dict()

    print("=" * 74)
    print("CONTROLS — all GROSS of costs, same entry/exit convention, same weeks")
    print("=" * 74)

    # 1. benchmark
    bench = adapter.benchmark_series(rule_spec["sector"]["benchmark_ticker"],
                                     rule_spec["data"]["history_weeks"])
    bench_rets = []
    if not bench.empty:
        for d in fold_dates:
            r = next_week_return(bench, d)
            if r is not None:
                bench_rets.append(r)
    bench_rets = np.array(bench_rets)

    # 2. universe average + 3. random pick (matched count), over the same weeks
    rng = np.random.default_rng(20260829)
    uni_rets, rand_rets = [], []
    for d in fold_dates:
        pool = eligible_tickers(panels, shares, uni, rule_spec, d)
        rs = [next_week_return(panels[t], d) for t in pool]
        rs = [r for r in rs if r is not None]
        if not rs:
            continue
        uni_rets.append(np.mean(rs))
        k = picks_per_week.get(d, 0)
        if k:
            rand_rets.extend(rng.choice(rs, size=min(k, len(rs)), replace=False))
    uni_rets = np.array(uni_rets)
    rand_rets = np.array(rand_rets)

    def line(name, arr, n_label="n"):
        if len(arr) == 0:
            print(f"  {name:24s}  (no data)")
            return
        m, lo, hi = bootstrap_ci(arr, n_boot=3000, seed=11)
        print(f"  {name:24s} {n_label}={len(arr):5d}  mean={m:+.3%}  "
              f"CI95=[{lo:+.3%}, {hi:+.3%}]  hit={np.mean(arr > 0):.1%}")

    line("STRATEGY (per trade)", strat, "trades")
    line("random pick (per trade)", rand_rets, "trades")
    line("universe avg (per week)", uni_rets, "weeks")
    line("benchmark (per week)", bench_rets, "weeks")

    print("\n" + "-" * 74)
    if len(rand_rets):
        diff = strat.mean() - rand_rets.mean()
        print(f"  STRATEGY minus RANDOM PICK : {diff:+.3%} per trade")
        # bootstrap the difference
        b = np.array([rng.choice(strat, len(strat), True).mean()
                      - rng.choice(rand_rets, len(rand_rets), True).mean() for _ in range(3000)])
        lo, hi = np.percentile(b, [2.5, 97.5])
        print(f"  bootstrap CI95 of difference: [{lo:+.3%}, {hi:+.3%}]"
              f"   -> {'SIGNIFICANT' if (lo > 0 or hi < 0) else 'not distinguishable from random'}")

    # ---- 4. NULL TEST: destroy the signal's information, keep the machinery
    print("\n" + "=" * 74)
    print("NULL TEST — shuffled weekly returns (harness validation)")
    print("=" * 74)
    print("If the harness reports an edge here, the harness is broken.")
    shuffled = {}
    srng = np.random.default_rng(4242)
    for t, p in panels.items():
        q = p.copy(deep=True).reset_index(drop=True)
        c = q["close"].to_numpy(float)
        if len(c) < 3 or not np.isfinite(c).all() or (c <= 0).any():
            shuffled[t] = q
            continue
        rets = np.diff(c) / c[:-1]
        srng.shuffle(rets)
        newc = np.empty_like(c)
        newc[0] = c[0]
        for i in range(1, len(c)):
            newc[i] = newc[i - 1] * (1 + rets[i - 1])
        scale = newc / c
        for col in ("open", "high", "low", "close"):
            q[col] = q[col].to_numpy(float) * scale
        shuffled[t] = q

    null_dates = fold_dates[::4]  # quarter of the folds, enough for a null read
    null_graded = rolling_walk_forward(null_dates, rule_spec, adapter, uni, shuffled, shares,
                                       progress_every=0)
    if null_graded.empty:
        print("  no trades generated on shuffled data (acceptable null outcome)")
    else:
        line("NULL strategy (per trade)", null_graded["ret_pct"].to_numpy(), "trades")
        m, lo, hi = bootstrap_ci(null_graded["ret_pct"].to_numpy(), n_boot=3000, seed=5)
        verdict = "PASS — no edge on noise" if (lo <= 0 <= hi) else "FAIL — harness finds edge in noise"
        print(f"  verdict: {verdict}")


if __name__ == "__main__":
    main()
