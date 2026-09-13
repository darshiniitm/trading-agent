"""Trade object construction: EP, SL, R, target, confidence (design doc §6)."""
from __future__ import annotations

import pandas as pd


def triangular_kernel(x: float, lo: float, hi: float) -> float:
    """Peaks at band centre, 0 at/outside [lo, hi]. Used for the RSI sweet-spot component."""
    if x is None or pd.isna(x) or x < lo or x > hi:
        return 0.0
    mid = (lo + hi) / 2
    half = (hi - lo) / 2
    if half == 0:
        return 1.0
    return 1.0 - abs(x - mid) / half


def clip01(x: float) -> float:
    if x is None or pd.isna(x):
        return 0.0
    return max(0.0, min(1.0, x))


def build_trades(survivors_df: pd.DataFrame, rule_spec: dict, next_week_open: dict[str, float] | None = None) -> pd.DataFrame:
    """
    survivors_df: output of run_screen()['survivors'].
    next_week_open: optional {ticker: open_price} for live-fillable EP (backtest supplies this
                     from the actual following week's data; live screen leaves it None -> EP is
                     marked 'pending' since next week hasn't happened yet).
    """
    if survivors_df.empty:
        return survivors_df.assign(EP=[], SL=[], R=[], target=[], RR=[], confidence=[])

    trade_cfg = rule_spec["trade"]
    weights = trade_cfg["confidence"]["weights"]
    rsi_lo, rsi_hi = _rsi_band_bounds(rule_spec)
    max_r_pct = trade_cfg["max_r_pct"]

    rows = []
    for _, s in survivors_df.iterrows():
        ticker = s["ticker"]
        if next_week_open and ticker in next_week_open:
            EP = next_week_open[ticker]
            entry_status = "filled"
        else:
            EP = s["close"]  # placeholder reference price for a not-yet-happened entry
            entry_status = "pending_next_week_open"

        SL = s["vstop_line"]
        if SL is None or pd.isna(SL) or EP is None:
            continue
        R = EP - SL
        if R <= 0 or (R / EP) > max_r_pct:
            continue  # reject: SL above/at entry, or implausibly wide (design doc §6.2)

        target = EP + trade_cfg["target_r_multiple"] * R
        RR = trade_cfg["target_r_multiple"]

        rr_comp = clip01(min(RR, 3.0) / 3.0)
        rsi_comp = triangular_kernel(s.get("rsi"), rsi_lo, rsi_hi)
        sector_rs_val = s.get("rs_4w") if "rs_4w" in s else s.get(f"rs_{rule_spec['sector']['rs_lookbacks_weeks'][0]}w")
        sector_comp = clip01((sector_rs_val + 0.10) / 0.20) if pd.notna(sector_rs_val) else 0.5
        trend_quality = (s["close"] - SL) / s["atr"] if s.get("atr") else 0.0
        trend_comp = clip01(trend_quality / 4.0)
        vol_comp = clip01((s["volume"] / s["avg_vol_8w"]) / 2.0) if s.get("avg_vol_8w") else 0.5
        liq_comp = clip01(s["median_weekly_turnover_cr"] / 50.0)

        confidence = 100 * (
            weights["rr"] * rr_comp
            + weights["rsi_sweetspot"] * rsi_comp
            + weights["sector_rs"] * sector_comp
            + weights["trend_quality"] * trend_comp
            + weights["volume"] * vol_comp
            + weights["liquidity"] * liq_comp
        )

        rows.append({
            **s.to_dict(),
            "EP": EP, "SL": SL, "R": R, "target": target, "RR": RR,
            "confidence": round(confidence, 1),
            "entry_status": entry_status,
        })

    return pd.DataFrame(rows)


def _rsi_band_bounds(rule_spec: dict) -> tuple[float, float]:
    for sig in rule_spec["signals"]:
        if sig["id"] == "rsi_band":
            pred = sig["predicate"]
            import re
            nums = re.findall(r"[\d.]+", pred)
            return float(nums[0]), float(nums[1])
    return 0.0, 100.0
