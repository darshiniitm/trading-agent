from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from src.data.holding_week import corrected_week_bar


@dataclass(frozen=True)
class SelectionPoint:
    session_of_week: int   # 1-5
    at: str                # "open" | "close"


def resolve_ep(ticker: str, weekly_panels: dict, daily_panels: dict | None,
               as_of: pd.Timestamp, selection_point: SelectionPoint) -> tuple[float | None, str]:
    """A real price at the selection point, or (None, "no_point_data"). Never fabricates one."""
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
