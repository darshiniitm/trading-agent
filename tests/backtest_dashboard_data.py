"""Emit every backtest number the dashboard needs, as JSON."""
from __future__ import annotations

import json
import numpy as np
import pandas as pd

from src.backtest.harness import (
    portfolio_metrics, summarize_trades, bootstrap_ci,
    rolling_walk_forward_trend_hold, trend_hold_return_stats,
)
from tests.offline import env, all_dates
from tests.controls import next_week_return

out = {}
rule_spec, adapter, uni, panels, shares = env()
dates = all_dates(panels)
folds = dates[-105:-1]
led = pd.read_parquet("/tmp/graded.parquet")

# ---------- weekly basket series, calendar-complete ----------
wk = led.groupby("week_start")["ret_pct_net"].agg(["count", "mean"]).reset_index()
wk.columns = ["week", "n", "ret"]
cal = pd.DataFrame({"week": folds}).merge(wk, on="week", how="left")
cal["n"] = cal["n"].fillna(0).astype(int)
cal["ret"] = cal["ret"].fillna(0.0)
cal["equity"] = (1 + cal["ret"]).cumprod()

# benchmark over the same weeks
bench = adapter.benchmark_series(rule_spec["sector"]["benchmark_ticker"], rule_spec["data"]["history_weeks"])
brets = []
for d in folds:
    r = next_week_return(bench, d)
    brets.append(0.0 if r is None else r)
cal["bench_ret"] = brets
cal["bench_equity"] = (1 + cal["bench_ret"]).cumprod()

out["equity"] = [
    {"w": str(r.week.date()), "n": int(r.n), "ret": round(float(r.ret), 6),
     "eq": round(float(r.equity), 5), "beq": round(float(r.bench_equity), 5)}
    for r in cal.itertuples()
]

# ---------- portfolio metrics: as-coded vs calendar-corrected ----------
rep = portfolio_metrics(wk.rename(columns={"week": "week_start", "ret": "portfolio_ret_net"})[["week_start", "portfolio_ret_net"]])
cor = portfolio_metrics(cal.rename(columns={"week": "week_start", "ret": "portfolio_ret_net"})[["week_start", "portfolio_ret_net"]])
bm = portfolio_metrics(cal.rename(columns={"week": "week_start", "bench_ret": "portfolio_ret_net"})[["week_start", "portfolio_ret_net"]])
out["portfolio"] = {"reported": {k: (None if pd.isna(v) else round(float(v), 5)) for k, v in rep.items()},
                    "corrected": {k: (None if pd.isna(v) else round(float(v), 5)) for k, v in cor.items()},
                    "benchmark": {k: (None if pd.isna(v) else round(float(v), 5)) for k, v in bm.items()}}
out["weeks_beat_bench"] = round(float((cal["ret"] > cal["bench_ret"]).mean()), 4)
out["weeks_positive"] = int((cal["ret"] > 0).sum())
out["weeks_total"] = int(len(cal))
out["weeks_traded"] = int((cal["n"] > 0).sum())

# ---------- trade-level ----------
s = summarize_trades(led)
out["trades"] = {k: (None if (isinstance(v, float) and pd.isna(v)) else (round(float(v), 6) if isinstance(v, (int, float, np.floating)) else v))
                 for k, v in s.items()}

# ---------- return distribution (histogram of net trade returns) ----------
r = led["ret_pct_net"].to_numpy() * 100
edges = np.arange(-18, 20, 2.0)
counts, _ = np.histogram(r, bins=edges)
out["hist"] = [{"lo": float(edges[i]), "hi": float(edges[i + 1]), "c": int(counts[i])} for i in range(len(counts))]

# ---------- trend-hold (secondary exit horizon) ----------
th = rolling_walk_forward_trend_hold(folds, rule_spec, adapter, uni, panels, shares, progress_every=0)
if not th.empty:
    ths = summarize_trades(th)
    out["trend_hold"] = {
        "n_trades": int(len(th)),
        "hit_rate": round(float((th["ret_pct_net"] > 0).mean()), 4),
        "mean_ret": round(float(th["ret_pct_net"].mean()), 5),
        "median_ret": round(float(th["ret_pct_net"].median()), 5),
        "ci": [round(float(x), 5) for x in bootstrap_ci(th["ret_pct_net"].to_numpy(), n_boot=3000, seed=17)[1:]],
        "mean_hold_weeks": round(float(th["hold_weeks"].mean()), 2),
        "median_hold_weeks": float(th["hold_weeks"].median()),
        "exit_mix": {k: int(v) for k, v in th["exit_reason"].value_counts().items()},
        "mean_mae": round(float(th["mae_pct"].mean()), 5),
        "ann": {k: (None if pd.isna(v) else round(float(v), 5)) for k, v in trend_hold_return_stats(th).items()},
    }
    th.to_parquet("/tmp/trend_hold.parquet")

print(json.dumps(out, indent=1)[:400])
with open("/home/claude/poc/dashboard_data.json", "w") as f:
    json.dump(out, f)
print("\nwrote dashboard_data.json")
print("trend_hold:", json.dumps(out.get("trend_hold", {}), indent=1))
print("portfolio:", json.dumps(out["portfolio"], indent=1))
