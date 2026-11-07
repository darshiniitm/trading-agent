"""Holiday gate and disk metric used by the production host (Engine Production Plan, phases 3/6)."""
from datetime import date
from types import SimpleNamespace

from scripts import emit_disk_metric, trading_day_gate


def test_gate_skips_weekends_and_listed_holidays(tmp_path):
    f = tmp_path / "h.yaml"
    f.write_text("holidays:\n  - 2026-11-09\n  - '2026-12-25'\n")
    assert not trading_day_gate.is_trading_day(date(2026, 11, 9), f)    # listed Monday
    assert not trading_day_gate.is_trading_day(date(2026, 11, 7), f)    # Saturday
    assert trading_day_gate.is_trading_day(date(2026, 11, 10), f)
    assert not trading_day_gate.is_trading_day(date(2026, 12, 25), f)


def test_gate_with_empty_calendar_only_skips_weekends(tmp_path):
    f = tmp_path / "h.yaml"
    f.write_text("holidays: []\n")
    assert trading_day_gate.is_trading_day(date(2026, 11, 9), f)


def test_gate_exit_codes():
    assert trading_day_gate.main(["2026-11-07"]) == 3     # Saturday
    assert trading_day_gate.main(["2026-11-10"]) == 0


def test_disk_gauge_ratio():
    g = emit_disk_metric.disk_gauges("/", usage=lambda p: SimpleNamespace(used=80, total=100))
    assert g == [("screener_disk_used_ratio", {"mount": "/"}, 0.8)]
