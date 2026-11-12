"""Exit 0 if the given date (default: today, IST) is an NSE trading day, 3 if it is a weekend or listed holiday.

Stdlib only so the host can run it without the engine image. Reads config/nse_holidays.yaml (a `holidays:` list of YYYY-MM-DD).
    python3 scripts/trading_day_gate.py [YYYY-MM-DD]
"""
from __future__ import annotations

import re
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

HOLIDAYS = Path(__file__).resolve().parents[1] / "config" / "nse_holidays.yaml"
IST = timezone(timedelta(hours=5, minutes=30))


def holidays(path: Path = HOLIDAYS) -> set[date]:
    if not path.exists():
        return set()
    out = set()
    for line in path.read_text().splitlines():
        m = re.match(r"^\s*-\s*['\"]?(\d{4}-\d{2}-\d{2})", line)
        if m:
            out.add(date.fromisoformat(m.group(1)))
    return out


def is_trading_day(d: date, path: Path = HOLIDAYS) -> bool:
    return d.weekday() < 5 and d not in holidays(path)


def main(argv=None) -> int:
    args = sys.argv[1:] if argv is None else argv
    d = date.fromisoformat(args[0]) if args else datetime.now(IST).date()
    ok = is_trading_day(d)
    print(f"{d} {'trading day' if ok else 'market closed (weekend or NSE holiday)'}")
    return 0 if ok else 3


if __name__ == "__main__":
    raise SystemExit(main())
