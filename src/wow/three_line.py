"""
The three-line weekly series (docs/wow-arm-history-analysis-plan.md §4.5): Control's
own basket vs. NIFTY MIDCAP 150 vs. NIFTY 50, all three open -> close on the SAME
holding-week bar, gross for the indices.

NIFTYMIDCAP150's line is not re-fetched: it is losslessly reconstructed from columns the
flag-matrix grading pipeline already writes (fwd_ret_oc_net_pct - fwd_excess_vs_benchmark_pct
recovers the same open->close bench_ret src/flags/grade.py already computed on the identical
holding-week bar — verified constant within a signal week to float noise).

NIFTY 50 (^NSEI) is the one new fetch this plan allows (§6.3) — done once via the live
OpenSourceAdapter into data_cache/weekly_ohlcv_260w.parquet (the same cache record()/grade()
already use), then read back offline like everything else in this study. It is a reporting
series only: never referenced by src/wow/arms.py or any gate/score/flag (T-12).
"""
from __future__ import annotations

from pathlib import Path

import pandas as pd

from src.flags.grade import _next_week_bar

ROOT = Path(__file__).resolve().parents[2]
NIFTY50_TICKER = "^NSEI"


def fetch_nifty50_into_cache(rule_spec: dict) -> dict:
    """The one write this study makes outside results/wow/ (§6.3). Verifies reachability
    the way NIFTYMIDCAP150.NS was verified (config/rules.yaml line 43); records which
    source was used so the manifest can carry it (D4).

    MUST fetch the full universe alongside ^NSEI, never ^NSEI alone: OpenSourceAdapter.
    weekly_ohlcv() (src/data/adapter.py) treats its 12h cache as all-or-nothing when
    stale -- a stale cache plus a single-ticker request silently OVERWRITES the entire
    multi-ticker weekly_ohlcv_260w.parquet with just that one ticker, corrupting the same
    cache record()/grade()/t1_replay() all depend on for live/replay data. Confirmed the
    hard way in this session -- see docs/wow_findings.md."""
    from src.data.adapter import build_adapter

    adapter = build_adapter(rule_spec)
    universe_df = adapter.nse_equities_pit(as_of=None)
    tickers = universe_df["ticker"].tolist() + [NIFTY50_TICKER]
    adapter.weekly_ohlcv(tickers, rule_spec["data"]["history_weeks"])  # refreshes the shared cache safely

    panel = adapter.benchmark_series(NIFTY50_TICKER, rule_spec["data"]["history_weeks"])
    if panel.empty:
        raise RuntimeError(f"{NIFTY50_TICKER} not reachable via yfinance — see D4 fallback "
                            f"(NIFTY50.NS or the NSE archive), not implemented here")
    return {"ticker": NIFTY50_TICKER, "source": "yfinance", "n_bars": len(panel)}


def _index_week_return(panel: pd.DataFrame, as_of: pd.Timestamp) -> tuple[float | None, bool]:
    """Open->close gross return of the SAME next-week bar Control's own grading uses
    (src/flags/grade.py:_next_week_bar) — never close-to-close, never the signal week (T-10)."""
    bar = _next_week_bar(panel, as_of)
    if bar is None:
        return None, True
    o, c = float(bar["open"]), float(bar["close"])
    if o == 0:
        return None, True
    return round((c - o) / o * 100, 4), False


def build_weekly_three_line(replay_df: pd.DataFrame, nifty50_panel: pd.DataFrame) -> pd.DataFrame:
    """One row per signal week on the Lane A grid: basket_net_pct (Control, equal-weight,
    already graded), niftymidcap150_wk_pct, nifty50_wk_pct (both gross, same holding-week
    bar), and the two spreads. Rendered even for cash weeks (basket_net_pct null, n_picks=0)."""
    rows = []
    for wk, wk_df in replay_df.groupby("signal_week"):
        as_of = pd.Timestamp(wk)
        control = wk_df[wk_df["control_status"] == "TRADE"]
        n_picks = len(control)
        basket_net = (round(float(control["fwd_ret_oc_net_pct"].dropna().mean()), 4)
                      if n_picks and control["fwd_ret_oc_net_pct"].notna().any() else None)
        basket_gross = (round(float((control["fwd_ret_oc_net_pct"] + 0.5).dropna().mean()), 4)
                        if n_picks and control["fwd_ret_oc_net_pct"].notna().any() else None)

        # NIFTYMIDCAP150: reconstructed losslessly from the already-graded columns —
        # constant within the week (any row will do); guard for an all-null week.
        bench_candidates = (wk_df["fwd_ret_oc_net_pct"] - wk_df["fwd_excess_vs_benchmark_pct"]).dropna()
        midcap_ret = round(float(bench_candidates.iloc[0]), 4) if not bench_candidates.empty else None
        midcap_missing = midcap_ret is None

        nifty50_ret, nifty50_missing = _index_week_return(nifty50_panel, as_of)

        rows.append({
            "signal_week": wk,
            "n_picks": n_picks,
            "basket_net_pct": basket_net,
            "basket_gross_pct": basket_gross,
            "niftymidcap150_wk_pct": midcap_ret,
            "nifty50_wk_pct": nifty50_ret,
            "vs_midcap150_pp": (round(basket_net - midcap_ret, 4)
                                 if basket_net is not None and midcap_ret is not None else None),
            "vs_nifty50_pp": (round(basket_net - nifty50_ret, 4)
                               if basket_net is not None and nifty50_ret is not None else None),
            "index_missing": bool(midcap_missing or nifty50_missing),
        })
    return pd.DataFrame(rows).sort_values("signal_week").reset_index(drop=True)
