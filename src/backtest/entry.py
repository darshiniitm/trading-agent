"""
Daily-resolution entry rules for V3 (pullback limit) and V4 (same-week confirmation)
(config/experiments.yaml; docs/open-decisions-implementation-plan.md §2). Both consume the
daily bars for a ticker that is ALREADY one of Control's own weekly survivors -- neither adds a
ticker the weekly funnel didn't already pick (HARNESS §9); they only re-time the entry for a
selection that's otherwise unchanged.
"""
from __future__ import annotations

import pandas as pd

from src.screen.daily_scale import daily_rule_spec
from src.screen.engine import _slice_as_of, compute_features_for_ticker, evaluate_predicate


def pullback_limit_fill(daily: pd.DataFrame, signal_friday: pd.Timestamp, limit: float,
                         window_days: int = 5) -> dict:
    """V3: limit buy at `limit` (the signal-week close), valid for the next `window_days`
    sessions after signal_friday. Fills at min(open, limit) on the first session whose low <=
    limit; no fill within the window -> {"filled": False} (recorded, not dropped -- callers
    report the fill rate)."""
    future = daily[daily["date"] > signal_friday].sort_values("date").head(window_days)
    for _, row in future.iterrows():
        if float(row["low"]) <= limit:
            return {"filled": True, "fill_price": min(float(row["open"]), limit),
                    "fill_date": pd.Timestamp(row["date"])}
    return {"filled": False, "fill_price": None, "fill_date": None}


def same_week_entry(daily: pd.DataFrame, rule_spec: dict, signal_week_start: pd.Timestamp) -> dict:
    """V4: scan the signal week's own daily bars (Mon..Fri) with the IDENTICAL VStop+RSI rule at
    daily resolution -- daily_rule_spec() rescales only the lookback fields (T1's detection
    pattern, not a second implementation of the predicate, HARNESS §2). Entry = next session's
    open after the first day within the week the rule is already true for this ticker. If no
    earlier day confirms (only Friday does, i.e. Control's own weekly close), entry falls back to
    the first session strictly after the week -- the same fill Control itself uses."""
    spec = daily_rule_spec(rule_spec)
    week_end = signal_week_start + pd.Timedelta(days=6)
    week_days = sorted(pd.Timestamp(d) for d in daily["date"].unique()
                        if signal_week_start <= pd.Timestamp(d) <= week_end)

    confirm_day = None
    for d in week_days:
        panel = _slice_as_of(daily, d)
        feats = compute_features_for_ticker(panel, spec)
        if feats is None:
            continue
        predicate_results = {}
        for sig in spec["signals"]:
            sig_locals = {"flip_up": feats["flip_up"], "flip_down": feats["flip_down"],
                          "value": feats["rsi"] if sig["indicator"] == "rsi" else None,
                          "uptrend": feats["uptrend"]}
            predicate_results[sig["id"]] = evaluate_predicate(sig["predicate"], sig_locals)
        combine = spec.get("combine", "AND")
        passed = all(predicate_results.values()) if combine == "AND" else any(predicate_results.values())
        if passed:
            confirm_day = d
            break

    after = confirm_day if confirm_day is not None else week_end
    future = daily[daily["date"] > after].sort_values("date")
    if future.empty:
        return {"confirmed_early": confirm_day is not None, "confirm_day": confirm_day,
                "entry_price": None, "entry_date": None}
    row = future.iloc[0]
    return {"confirmed_early": confirm_day is not None, "confirm_day": confirm_day,
            "entry_price": float(row["open"]), "entry_date": pd.Timestamp(row["date"])}
