"""
IST clock + recording-mode resolution (docs/feature-flag-matrix-plan.md §2, G4, G5).

A weekly bar's signal week is Mon..Fri; the holding week opens the following
Monday 09:15 IST. `forward` mode requires the flag record to be created
before that open; anything after is `late_backfill` — still useful evidence,
excluded from T4 gate statistics (§7.1).
"""
from __future__ import annotations

from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

import pandas as pd

IST = ZoneInfo("Asia/Kolkata")
MARKET_OPEN = time(9, 15)


def now_ist() -> datetime:
    return datetime.now(timezone.utc).astimezone(IST)


def holding_week_monday(as_of: pd.Timestamp) -> pd.Timestamp:
    """The Monday that opens the week after the signal week."""
    return pd.Timestamp(as_of) + pd.Timedelta(weeks=1)


def monday_open_deadline(as_of: pd.Timestamp) -> datetime:
    hw = holding_week_monday(as_of)
    return datetime.combine(hw.date(), MARKET_OPEN, tzinfo=IST)


def week_has_closed(as_of: pd.Timestamp, now: datetime | None = None) -> bool:
    """G4: refuse to record a week that hasn't closed — signal week's Friday
    must be in the past (its bar assumed final only once Friday 15:30 IST has passed,
    matching the data-freshness assumption in I9). Weekly bars are Monday-dated
    (the bar's `date` is that week's Monday; the signal is that week's Friday close
    — same convention as tests/track_forward.py's picks_*.json signal_week_note),
    so the Friday in question is as_of + 4 days, not as_of itself."""
    now = now or now_ist()
    friday = pd.Timestamp(as_of) + pd.Timedelta(days=4)
    friday_close = datetime.combine(friday.date(), time(15, 30), tzinfo=IST)
    return now >= friday_close


def resolve_mode(as_of: pd.Timestamp, created_at: datetime | None = None) -> str:
    """forward if created before the holding week's Monday 09:15 IST deadline,
    else late_backfill. Never passed in by the caller as `forward` after the
    deadline (G5) — always derived here."""
    created_at = created_at or now_ist()
    deadline = monday_open_deadline(as_of)
    return "forward" if created_at < deadline else "late_backfill"
