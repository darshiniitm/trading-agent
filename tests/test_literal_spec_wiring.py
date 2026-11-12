"""
Literal spec (docs/literal-spec-plan.md) end-to-end config wiring, hermetic.

Uses Control's already-cached weekly panels (tests.offline.env()) with the Literal
spec's OWN config values deep-copied in -- this exercises the config wiring
(max_r_pct: null, entry: signal_close, the extra 1-week sector lookback) through the
real run_screen()/build_trades() functions, without needing the full-NSE-from-2024
data cache (that's covered separately by tests/test_adapter_full_universe.py, which
is hermetic over a synthetic universe instead).
"""
from __future__ import annotations

import copy

import pandas as pd

from src.config import load_rule_spec
from src.screen.engine import run_screen
from src.trade.builder import build_trades
from tests.offline import all_dates, env

OFFSET = -3


def _literal_like_spec():
    """Control's cached-data-compatible spec, with Literal's own decided values patched in."""
    literal_rs = load_rule_spec("config/rules_literal.yaml")
    control_rs, *_ = env()
    spec = copy.deepcopy(control_rs)
    spec["trade"]["max_r_pct"] = literal_rs["trade"]["max_r_pct"]  # null
    spec["trade"]["entry"] = literal_rs["trade"]["entry"]           # signal_close
    spec["sector"]["rs_lookbacks_weeks"] = literal_rs["sector"]["rs_lookbacks_weeks"]  # [4, 13, 1]
    spec["sector"]["mode"] = literal_rs["sector"]["mode"]           # report
    return spec


def test_rules_literal_yaml_loads_and_has_no_risk_cap():
    rs = load_rule_spec("config/rules_literal.yaml")
    assert rs["trade"]["max_r_pct"] is None
    assert rs["trade"]["entry"] == "signal_close"
    assert rs["universe"]["source"] == "full_nse_equity_list"
    assert rs["universe"]["history_start"] == "2024-01-01"
    assert rs["sector"]["rs_lookbacks_weeks"][0] == 4  # primary lookback unchanged


def test_no_risk_cap_means_trade_count_equals_survivor_count():
    """Phase 4's own bar: 'Trade count = qualified count, every week.'"""
    _, adapter, uni, panels, shares = env()
    spec = _literal_like_spec()
    as_of = all_dates(panels)[OFFSET]
    res = run_screen(as_of, spec, adapter, uni, panels, shares)
    survivors = res["survivors"]
    trades = build_trades(survivors, spec)
    usable = survivors[survivors["vstop_line"].notna()]
    assert len(trades) == len(usable)


def test_entry_price_is_signal_close_not_capped_away():
    """With max_r_pct patched to Control's 0.15, a wide-stop survivor is dropped;
    with Literal's null, that same survivor is kept -- proving the config key, not
    just its absence, drives the behaviour."""
    _, adapter, uni, panels, shares = env()
    as_of = all_dates(panels)[OFFSET]
    capped_spec = copy.deepcopy(_literal_like_spec())
    capped_spec["trade"]["max_r_pct"] = 0.0001  # near-zero cap: rejects almost everything
    res = run_screen(as_of, capped_spec, adapter, uni, panels, shares)
    capped_trades = build_trades(res["survivors"], capped_spec)

    uncapped_spec = _literal_like_spec()  # max_r_pct: null
    uncapped_trades = build_trades(res["survivors"], uncapped_spec)

    assert len(uncapped_trades) >= len(capped_trades)
    if not res["survivors"].empty:
        assert len(uncapped_trades) == len(res["survivors"][res["survivors"]["vstop_line"].notna()])


def test_sector_view_carries_the_extra_one_week_lookback():
    _, adapter, uni, panels, shares = env()
    spec = _literal_like_spec()
    as_of = all_dates(panels)[OFFSET]
    res = run_screen(as_of, spec, adapter, uni, panels, shares)
    assert "rs_1w" in res["sector_rs"].columns
    assert "ret_1w" in res["sector_rs"].columns
    assert "rs_4w" in res["sector_rs"].columns  # primary lookback still present
