from __future__ import annotations

import pandas as pd

from engine.schemas import SelectionPoint
from src.data.holding_week import corrected_week_bar


def resolve_ep(ticker: str, weekly_panels: dict, daily_panels: dict | None,
               as_of: pd.Timestamp, selection_point: SelectionPoint) -> tuple[float | None, str]:
    as_of = pd.Timestamp(as_of)
    panel = weekly_panels.get(ticker)
    if panel is None or panel.empty:
        return None, "no_point_data"

    next_week_rows = panel[panel["date"] > as_of].sort_values("date")
    if next_week_rows.empty:
        return None, "no_point_data"
    week_start = pd.Timestamp(next_week_rows.iloc[0]["date"])

    if selection_point.session_of_week == 1 and selection_point.at == "open":
        row = next_week_rows.iloc[0]
        bar = corrected_week_bar(ticker, daily_panels, week_start,
                                  fallback_open=float(row["open"]), fallback_low=float(row["low"]),
                                  fallback_close=float(row["close"]))
        return bar["open"], "ok"

    panel_d = (daily_panels or {}).get(ticker)
    if panel_d is None or panel_d.empty:
        return None, "no_point_data"
    week_end = week_start + pd.Timedelta(days=6)
    days = panel_d[(pd.to_datetime(panel_d["date"]) >= week_start) &
                   (pd.to_datetime(panel_d["date"]) <= week_end)].sort_values("date")
    idx = selection_point.session_of_week - 1
    if idx >= len(days):
        return None, "no_point_data"
    col = "open" if selection_point.at == "open" else "close"
    return float(days.iloc[idx][col]), "ok"


def select_candidates(spec, as_of: pd.Timestamp, env, screen_result: dict) -> dict:
    """Never fabricates a price. A full_match candidate is 'entered' only when a real
    selection-point price was resolved; with no selection_point in the spec, or when
    resolve_ep can't find one, the candidate goes to no_point_data -- the app-side
    confirm gate is expected to block confirming a prompt with no selection_point at
    all (backend plan §10's 'Open parameters'/'Structure applicability' tests), but
    this function does not rely on that upstream gate to stay honest on its own."""
    out = {"entered": [], "not_confirmed": [], "no_point_data": [], "watching": []}
    for cand in screen_result["candidates"]:
        ticker = cand["ticker"]
        if cand["membership"] != "full_match":
            ref_price, status = resolve_ep(ticker, env.panels, env.daily_panels, as_of,
                                            spec.selection_point) if spec.selection_point else (None, "no_point_data")
            out["watching"].append({**cand, "ref_price": ref_price})
            continue

        if spec.selection_point is None:
            out["no_point_data"].append({**cand, "reason": "no selection point in spec"})
            continue

        ep, status = resolve_ep(ticker, env.panels, env.daily_panels, as_of, spec.selection_point)
        if status == "no_point_data":
            out["no_point_data"].append({**cand, "reason": "selection-point price unavailable"})
            continue

        event_conds = [c for c in spec.conditions if c.role == "event"]
        still_valid = all(cand["values"].get(c.id, {}).get("uptrend", False) for c in event_conds) if event_conds else True
        if still_valid:
            out["entered"].append({**cand, "entry_price": ep})
        else:
            out["not_confirmed"].append({**cand, "entry_price": ep})
    return out
