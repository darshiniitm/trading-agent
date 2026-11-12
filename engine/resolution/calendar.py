"""NSE trading calendar for the freshness check (spec §3.3)."""
from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path

import yaml

from engine.resolution.config import ROOT


def _d(x) -> date:
    return x if isinstance(x, date) and not hasattr(x, "hour") else __import__("pandas").Timestamp(x).date()


class TradingCalendar:
    def __init__(self, holidays=()):
        self.holidays = {_d(h) for h in holidays}

    @classmethod
    def from_file(cls, path: str | Path | None = None, learned: set | None = None) -> "TradingCalendar":
        p = Path(path) if path else ROOT / "config" / "nse_holidays.yaml"
        raw = yaml.safe_load(p.read_text()) if p.exists() else {}
        return cls(list((raw or {}).get("holidays") or []) + list(learned or []))

    def is_trading_day(self, d) -> bool:
        d = _d(d)
        return d.weekday() < 5 and d not in self.holidays

    def last_trading_day(self, on_or_before) -> date:
        d = _d(on_or_before)
        while not self.is_trading_day(d):
            d -= timedelta(days=1)
        return d

    def trading_days_between(self, start, end) -> int:
        """Trading days in (start, end]."""
        s, e, n = _d(start), _d(end), 0
        while s < e:
            s += timedelta(days=1)
            n += self.is_trading_day(s)
        return n
