"""
T1 rolling-window shadow arm: run the exact same VStop+RSI rule against daily
bars instead of only the Friday-close weekly anchor (docs/forward-test-
response-and-volume-plan.md §3.2).

The strategy spec (config/rules.yaml) never changes for this — the ground
rule the plan sets is that no condition in the spec moves. daily_rule_spec()
only builds an in-memory copy with the two lookback fields that are consumed
as raw bar counts (universe.liquidity.lookback_weeks, sector.rs_lookbacks_weeks)
scaled so an "8-week" liquidity floor stays an 8-week floor when read against
daily bars instead of weekly ones. VStop/RSI parameters and the risk cap are
left untouched on purpose: testing the identical rule at finer resolution is
the whole point of T1, not a slower daily-equivalent version of it.
"""
from __future__ import annotations

import copy

TRADING_DAYS_PER_WEEK = 5


def daily_rule_spec(rule_spec: dict, days_per_week: int = TRADING_DAYS_PER_WEEK) -> dict:
    spec = copy.deepcopy(rule_spec)
    spec["universe"]["liquidity"]["lookback_weeks"] *= days_per_week
    spec["sector"]["rs_lookbacks_weeks"] = [
        w * days_per_week for w in spec["sector"]["rs_lookbacks_weeks"]
    ]
    return spec
