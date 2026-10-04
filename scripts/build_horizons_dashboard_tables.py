"""One-off: render the table AND chart data docs/dashboards/test-vs-control-ledger.html's
§04 uses, for the 1-/2-/3-week horizon-grading replay
(results/literal_test/replay/horizons_replay_*.jsonl, src/backtest/horizons.py).
Mirrors the exact table shape/CSS classes already used in §02/§03 (per-week aggregate,
most-recent-N-weeks ticker detail) so the rows drop in without a style change, plus the
per-week our-vs-Nifty50 series the §04 trend-line charts (lineChart(), same function as
docs/dashboards/wow-trend-dashboard.html's) plot directly. Prints ready-to-paste <tr> HTML
fragments and a JSON data blob; the dashboard edit is manual (same discipline as
scripts/extract_wow_dashboard_data.py).

Usage:
  python -m scripts.build_horizons_dashboard_tables tables [jsonl_path] [n_recent_weeks]
  python -m scripts.build_horizons_dashboard_tables trend_data [jsonl_path] [view]
"""
from __future__ import annotations

import sys
import json
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]


def _fmt_pct(v):
    if v is None or pd.isna(v):
        return '<td class="n">&mdash;</td>'
    cls = "pos" if v > 0 else ("neg" if v < 0 else "")
    return f'<td class="n {cls}">{v:+.2f}%</td>'


def _fmt_num(v):
    return f'<td class="n">{v:,.2f}</td>'


def per_week_table(df: pd.DataFrame, view: str) -> str:
    sub = df[(df["view"] == view) & (df["status"] == "graded")]
    rows = []
    for week, g in sub.groupby("signal_week_start"):
        tickers = sorted(g["ticker"].str.replace(".NS", "", regex=False).unique())
        n_picks = g["ticker"].nunique()
        cells = [f'<td class="n">{week}</td>', f'<td class="n">{n_picks}</td>']
        for h in (1, 2, 3):
            gh = g[g["horizon_weeks"] == h]
            if gh.empty:
                cells.append('<td class="n">&mdash;</td>')
            else:
                cells.append(_fmt_pct(gh["r_Nw"].mean()))
        for h in (1, 2, 3):
            gh = g[g["horizon_weeks"] == h]
            if gh.empty:
                cells.append('<td class="n">&mdash;</td>')
            else:
                hit = (gh["r_Nw"] > 0).mean() * 100
                cells.append(f'<td class="n">{hit:.1f}%</td>')
        tick_html = ", ".join(tickers)
        cells.append(f'<td style="text-align:left;font-size:11.5px;color:var(--ink-3)">{tick_html}</td>')
        rows.append(f"<tr>{''.join(cells)}</tr>")
    return "\n".join(rows)


def ticker_detail_table(df: pd.DataFrame, view: str, n_recent_weeks: int) -> str:
    sub = df[(df["view"] == view) & (df["status"] == "graded")]
    recent_weeks = sorted(sub["signal_week_start"].unique())[-n_recent_weeks:]
    sub = sub[sub["signal_week_start"].isin(recent_weeks)]

    piv = sub.pivot_table(index=["signal_week_start", "ticker", "buy_price"],
                           columns="horizon_weeks", values="r_Nw", aggfunc="first").reset_index()
    # "final" status per (week, ticker) = its own latest graded horizon, not a global
    # max -- a just-signalled week may only have horizon 1 gradable yet.
    latest_idx = sub.groupby(["signal_week_start", "ticker"])["horizon_weeks"].idxmax()
    exit_info = sub.loc[latest_idx].set_index(["signal_week_start", "ticker"])[["exit_reason", "sl_hit_week"]]

    rows = []
    for _, r in piv.sort_values(["signal_week_start", "ticker"]).iterrows():
        week, ticker, ep = r["signal_week_start"], r["ticker"], r["buy_price"]
        cells = [f'<td class="n">{week}</td>', f'<td class="tick">{ticker.replace(".NS", "")}</td>',
                 _fmt_num(ep)]
        for h in (1, 2, 3):
            cells.append(_fmt_pct(r.get(h)))
        key = (week, ticker)
        exit_reason = exit_info.loc[key, "exit_reason"] if key in exit_info.index else None
        sl_week = exit_info.loc[key, "sl_hit_week"] if key in exit_info.index else None
        exit_label = exit_reason if exit_reason and pd.notna(exit_reason) else "&mdash;"
        if sl_week is not None and pd.notna(sl_week):
            exit_label += f" ({sl_week})"
        cells.append(f"<td>{exit_label}</td>")
        rows.append(f"<tr>{''.join(cells)}</tr>")
    return "\n".join(rows)


def trend_data(df: pd.DataFrame, view: str) -> dict:
    """Per-week mean r_Nw (ours) vs mean bench_Nw (Nifty 50), one series pair per
    horizon -- exactly what §04's lineChart() calls plot. Not cumulative/compounded:
    2- and 3-week windows from consecutive Fridays overlap, so a compounded equity
    curve would double-count weeks (only the 1-week series is non-overlapping)."""
    sub = df[(df["view"] == view) & (df["status"] == "graded")]
    all_weeks = sorted(sub["signal_week_start"].unique())
    per_week = (sub.groupby(["signal_week_start", "horizon_weeks"])
                .agg(our=("r_Nw", "mean"), nifty=("bench_Nw", "mean")).reset_index())
    out = {"weeks": all_weeks}
    for h in (1, 2, 3):
        by_week = per_week[per_week["horizon_weeks"] == h].set_index("signal_week_start")
        out[f"our_{h}w"] = [round(float(by_week.loc[w, "our"]), 3) if w in by_week.index else None
                             for w in all_weeks]
        out[f"nifty_{h}w"] = [round(float(by_week.loc[w, "nifty"]), 3) if w in by_week.index else None
                               for w in all_weeks]
    return out


def main(cmd: str, jsonl_path: str, extra):
    rows = [json.loads(line) for line in Path(jsonl_path).read_text().splitlines() if line.strip()]
    df = pd.DataFrame(rows)

    if cmd == "trend_data":
        view = extra or "trade"
        print(json.dumps(trend_data(df, view)))
        return

    n_recent_weeks = int(extra) if extra else 8
    print("=" * 20, "SIGNAL VIEW -- every week", "=" * 20)
    print(per_week_table(df, "signal"))
    print()
    print("=" * 20, "TRADE VIEW -- every week", "=" * 20)
    print(per_week_table(df, "trade"))
    print()
    print("=" * 20, f"TRADE VIEW -- most recent {n_recent_weeks} weeks, ticker detail", "=" * 20)
    print(ticker_detail_table(df, "trade", n_recent_weeks))


if __name__ == "__main__":
    args = sys.argv[1:]
    cmd = args[0] if args and args[0] in ("tables", "trend_data") else "tables"
    rest = args[1:] if args and args[0] in ("tables", "trend_data") else args
    jsonl = rest[0] if rest else str(
        ROOT / "results" / "literal_test" / "replay" / "horizons_replay_2024-01-01_2026-09-21.jsonl")
    extra = rest[1] if len(rest) > 1 else None
    main(cmd, jsonl, extra)
