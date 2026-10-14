"""
D7 fix (.claude/HARNESS.md #7, .claude/GLOSSARY.md): in a week whose Monday is an NSE
holiday, yfinance's weekly bar reports the previous Friday's close as that week's open,
not the first real session's open. Every grader that reads EP off the weekly bar
(tests/track_forward.py:_grade_rows, src/flags/grade.py:grade_matrix) books EP = signal
close in those weeks instead of the actual fill.

`corrected_week_bar` prefers the holding week's own daily sessions (from
adapter.daily_ohlcv, the same cache T1 already uses) when they cover that week, and
falls back to the weekly bar's own open/low/close otherwise -- so a ticker with no daily
coverage grades exactly as it did before this fix. Nothing here re-grades a past record;
callers only pass daily panels going forward from the point this landed (16 Sep 2026).

Residual defect fixed 2026-09-27 (.claude/HARNESS.md #7): on the holiday Monday itself,
yfinance's daily cache can carry a zero-volume placeholder row (open == high == low ==
close == the prior Friday's close) dated *on* that Monday, ahead of the first real
session. Left unfiltered, `days.iloc[0]` picked that placeholder's open -- numerically
identical to the pre-fix weekly-bar bug this function exists to correct. Placeholder
rows (volume <= 0, or missing) are now dropped before open/low/close are read off the
week's real sessions.
"""
from __future__ import annotations

import pandas as pd


def corrected_week_bar(ticker: str, daily_panels: dict[str, pd.DataFrame] | None, week_start: pd.Timestamp,
                        fallback_open: float, fallback_low: float, fallback_close: float) -> dict:
    """week_start: Monday-dated start of the holding week (the weekly bar's own date).
    Returns {"open", "low", "close", "source"} where source is "daily" when the daily
    cache actually covered that week's real (non-placeholder) sessions, else
    "weekly_bar" (the pre-fix value)."""
    week_start = pd.Timestamp(week_start).normalize()
    panel = (daily_panels or {}).get(ticker)
    if panel is not None and not panel.empty:
        week_end = week_start + pd.Timedelta(days=6)
        d = panel.copy()
        d["date"] = pd.to_datetime(d["date"]).dt.tz_localize(None).dt.normalize()
        days = d[(d["date"] >= week_start) & (d["date"] <= week_end)].sort_values("date")
        if "volume" in days.columns:
            days = days[days["volume"].fillna(0) > 0]
        if not days.empty:
            return {"open": float(days.iloc[0]["open"]), "low": float(days["low"].min()),
                    "close": float(days.iloc[-1]["close"]), "source": "daily"}
    return {"open": fallback_open, "low": fallback_low, "close": fallback_close, "source": "weekly_bar"}
