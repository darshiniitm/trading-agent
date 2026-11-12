"""
Screening engine — generic predicate evaluator over a filter funnel (design doc §7).

`run_screen(as_of, rule_spec, adapter, ...)` is the ONE code path used by both
the live screen and every backtest fold. As-of correctness (point-in-time,
completed bars only) is enforced by slicing every ticker's weekly panel to
rows with date <= as_of before any indicator is computed.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import pandas as pd

from src.indicators.rsi import compute_rsi
from src.indicators.sector_rs import compute_sector_rs, flag_outperforming
from src.indicators.vstop import compute_vstop

CR = 1e7  # 1 crore = 10,000,000


@dataclass
class FunnelReport:
    stages: list[tuple[str, int]] = field(default_factory=list)

    def log(self, stage: str, count: int):
        self.stages.append((stage, count))

    def as_dataframe(self) -> pd.DataFrame:
        return pd.DataFrame(self.stages, columns=["stage", "count"])


def _slice_as_of(panel: pd.DataFrame, as_of: pd.Timestamp) -> pd.DataFrame:
    """Point-in-time slice: only bars with date <= as_of (completed weekly bars only)."""
    return panel[panel["date"] <= as_of].reset_index(drop=True)


def compute_features_for_ticker(panel: pd.DataFrame, rule_spec: dict) -> dict | None:
    """Compute all indicators for one ticker's PIT-sliced weekly panel."""
    min_bars = rule_spec["data"]["min_bars_required"]
    if len(panel) < min_bars:
        return None

    vstop_params = next(s["params"] for s in rule_spec["signals"] if s["id"] == "vstop_flip")
    rsi_params = next(s["params"] for s in rule_spec["signals"] if s["id"] == "rsi_band")

    vdf = compute_vstop(panel, length=vstop_params["length"], mult=vstop_params["mult"], source=vstop_params["source"])
    rsi_series = compute_rsi(panel["close"], period=rsi_params["period"])

    last = vdf.iloc[-1]
    return {
        "close": float(last["close"]),
        "open": float(last["open"]),
        "high": float(last["high"]),
        "low": float(last["low"]),
        "volume": float(last["volume"]),
        "atr": float(last["atr"]) if pd.notna(last["atr"]) else None,
        "vstop_line": float(last["vstop_line"]) if pd.notna(last["vstop_line"]) else None,
        "uptrend": bool(last["uptrend"]),
        "flip_up": bool(last["flip_up"]),
        "flip_down": bool(last["flip_down"]),
        "rsi": float(rsi_series.iloc[-1]) if pd.notna(rsi_series.iloc[-1]) else None,
        "avg_vol_8w": float(panel["volume"].tail(8).mean()),
        "date": last["date"],
    }


def evaluate_predicate(predicate: str, features_for_signal: dict) -> bool:
    safe_locals = dict(features_for_signal)
    try:
        return bool(eval(predicate, {"__builtins__": {}}, safe_locals))  # noqa: S307 - controlled spec-authored expr
    except Exception:
        return False


def run_screen(as_of: pd.Timestamp, rule_spec: dict, adapter, universe_df: pd.DataFrame,
                weekly_panels: dict[str, pd.DataFrame], shares_map: dict[str, float],
                benchmark_fetch=None, include_eligible_features: bool = False) -> dict:
    """
    universe_df: DataFrame[ticker, name, sector, isin] (candidate universe, pre-PIT-filter)
    weekly_panels: dict ticker -> full weekly OHLCV DataFrame (will be PIT-sliced here)
    shares_map: dict ticker -> shares outstanding (current; PIT caveat, see adapter.py)
    benchmark_fetch: optional (ticker, history) -> DataFrame, defaults to
                     adapter.benchmark_series(ticker, rule_spec["data"]["history_weeks"]).
                     Callers running this same funnel against daily bars (T1) pass a daily
                     fetch here instead — the default path is unchanged either way.
    include_eligible_features: when True, also return "eligible_features" — one row
                     per liquidity_filter-stage ticker (survivor or not) with identity,
                     all compute_features_for_ticker() fields (or eligible_reason =
                     insufficient_history), predicate_results, and sector-RS columns.
                     Every other return-dict key is unchanged flag on/off
                     (tests/test_run_screen_eligible_features.py::T-04). Feeds
                     src/flags/matrix.py — the only sanctioned way to get features for
                     non-survivors; do not reimplement the cap/liquidity stages elsewhere.
    """
    funnel = FunnelReport()
    funnel.log("candidate_universe", len(universe_df))

    cap_cfg = rule_spec["universe"]["market_cap_cr"]
    liq_cfg = rule_spec["universe"]["liquidity"]

    stage0_rows = []
    for _, row in universe_df.iterrows():
        ticker = row["ticker"]
        panel_full = weekly_panels.get(ticker)
        if panel_full is None or panel_full.empty:
            continue
        panel = _slice_as_of(panel_full, as_of)
        if panel.empty:
            continue
        shares = shares_map.get(ticker)
        if not shares:
            continue
        last_close = panel["close"].iloc[-1]
        mktcap_cr = (last_close * shares) / CR
        if not (cap_cfg["min"] <= mktcap_cr <= cap_cfg["max"]):
            continue
        stage0_rows.append({"ticker": ticker, "name": row["name"], "sector": row["sector"],
                             "panel": panel, "mktcap_cr": mktcap_cr})
    funnel.log("universe_market_cap_band", len(stage0_rows))

    stage1_rows = []
    for r in stage0_rows:
        panel = r["panel"]
        turnover_cr = (panel["close"] * panel["volume"]).tail(liq_cfg["lookback_weeks"]) / CR
        if len(turnover_cr) == 0:
            continue
        med_turnover = turnover_cr.median()
        if med_turnover < liq_cfg["min"]:
            continue
        r["median_weekly_turnover_cr"] = med_turnover
        stage1_rows.append(r)
    funnel.log("liquidity_filter", len(stage1_rows))

    survivors = []
    near_miss = []
    drop_log = []
    eligible_rows = [] if include_eligible_features else None
    signal_specs = rule_spec["signals"]
    combine = rule_spec.get("combine", "AND")
    flip_count = 0

    for r in stage1_rows:
        feats = compute_features_for_ticker(r["panel"], rule_spec)
        if feats is None:
            drop_log.append((r["ticker"], "insufficient_history"))
            if eligible_rows is not None:
                eligible_rows.append({
                    "ticker": r["ticker"], "name": r["name"], "sector": r["sector"],
                    "mktcap_cr": r["mktcap_cr"], "median_weekly_turnover_cr": r["median_weekly_turnover_cr"],
                    "eligible_reason": "insufficient_history",
                })
            continue

        predicate_results = {}
        for sig in signal_specs:
            sig_locals = {
                "flip_up": feats["flip_up"],
                "flip_down": feats["flip_down"],
                "value": feats["rsi"] if sig["indicator"] == "rsi" else None,
                "uptrend": feats["uptrend"],
            }
            predicate_results[sig["id"]] = evaluate_predicate(sig["predicate"], sig_locals)

        if eligible_rows is not None:
            eligible_rows.append({
                "ticker": r["ticker"], "name": r["name"], "sector": r["sector"],
                "mktcap_cr": r["mktcap_cr"], "median_weekly_turnover_cr": r["median_weekly_turnover_cr"],
                "eligible_reason": None,
                "predicate_results": dict(predicate_results),
                **feats,
            })

        if feats["flip_up"]:
            flip_count += 1

        passed = all(predicate_results.values()) if combine == "AND" else any(predicate_results.values())
        if not passed:
            failed = [k for k, v in predicate_results.items() if not v]
            drop_log.append((r["ticker"], f"failed:{','.join(failed)}"))
            # near-miss: the trend-following signal fired but a later filter
            # (e.g. RSI band) vetoed it — worth tracking, since it's a real
            # trade the strategy chose NOT to take, not just noise.
            if feats["flip_up"]:
                near_miss.append({
                    "ticker": r["ticker"], "name": r["name"], "sector": r["sector"],
                    "mktcap_cr": r["mktcap_cr"], "median_weekly_turnover_cr": r["median_weekly_turnover_cr"],
                    "failed_signals": failed,
                    **feats,
                })
            continue

        survivors.append({
            "ticker": r["ticker"], "name": r["name"], "sector": r["sector"],
            "mktcap_cr": r["mktcap_cr"], "median_weekly_turnover_cr": r["median_weekly_turnover_cr"],
            **feats,
        })

    funnel.log("vstop_flip", flip_count)
    funnel.log("survivors_after_rsi_band", len(survivors))

    survivors_df = pd.DataFrame(survivors)
    near_miss_df = pd.DataFrame(near_miss)

    # sector RS (soft — highlight only, never eliminates a stock; design doc §5)
    sector_map = universe_df[["ticker", "sector"]]
    all_panels_sliced = {t: _slice_as_of(p, as_of) for t, p in weekly_panels.items()}
    fetch = benchmark_fetch or (lambda ticker, n: adapter.benchmark_series(ticker, n))
    benchmark_panel = fetch(rule_spec["sector"].get("benchmark_ticker", ""), rule_spec["data"]["history_weeks"])
    benchmark_close = _slice_as_of(benchmark_panel, as_of)["close"] if not benchmark_panel.empty else pd.Series(dtype=float)

    sector_rs_df = compute_sector_rs(
        sector_map, all_panels_sliced, benchmark_close, rule_spec["sector"]["rs_lookbacks_weeks"]
    )
    primary_lb = rule_spec["sector"]["rs_lookbacks_weeks"][0]
    sector_rs_df = flag_outperforming(
        sector_rs_df, f"rs_{primary_lb}w",
        rule_spec["sector"]["outperforming"]["rs_gt"],
        rule_spec["sector"]["outperforming"]["top_k"],
    )

    if not survivors_df.empty:
        survivors_df = survivors_df.merge(
            sector_rs_df[["sector", f"rs_{primary_lb}w", "rs_rank", "outperforming"]],
            on="sector", how="left",
        )

    result = {
        "as_of": as_of,
        "survivors": survivors_df,
        "near_miss": near_miss_df,
        "sector_rs": sector_rs_df,
        "funnel": funnel.as_dataframe(),
        "drop_log": drop_log,
    }

    if include_eligible_features:
        eligible_df = pd.DataFrame(eligible_rows)
        if not eligible_df.empty and "sector" in eligible_df.columns:
            rs_cols = [c for c in sector_rs_df.columns if c.startswith("rs_")]
            merge_cols = ["sector", "rs_rank", "outperforming"] + rs_cols
            merge_cols = [c for c in dict.fromkeys(merge_cols) if c in sector_rs_df.columns]
            eligible_df = eligible_df.merge(sector_rs_df[merge_cols], on="sector", how="left")
        result["eligible_features"] = eligible_df

    return result
