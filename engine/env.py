from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import pandas as pd

RULE_SPEC_PATHS = {
    "literal": "config/rules_literal.yaml",
    "t1_literal": "config/rules_literal.yaml",  # same universe/cache as Literal (D1)
}


@dataclass
class Environment:
    rule_spec: dict
    adapter: object
    universe_df: pd.DataFrame
    panels: dict
    shares: dict
    daily_panels: dict | None = None


_CACHE: dict[tuple[str, bool], Environment] = {}


def _load_live(structure: str) -> Environment:
    from scripts.common import bootstrap
    rule_spec, adapter, universe_df, panels, shares = bootstrap(RULE_SPEC_PATHS[structure])
    daily_panels = adapter.daily_ohlcv(list(panels.keys()), rule_spec["data"]["history_weeks"] * 7)
    return Environment(rule_spec, adapter, universe_df, panels, shares, daily_panels)


def _load_offline(structure: str) -> Environment:
    from tests.offline import env_literal
    rule_spec, adapter, universe_df, panels, shares = env_literal()
    daily_panels = adapter.daily_ohlcv(list(panels.keys()), rule_spec["data"]["history_weeks"] * 7)
    return Environment(rule_spec, adapter, universe_df, panels, shares, daily_panels)


def load_environment(structure: Literal["literal", "t1_literal"], offline: bool = False) -> Environment:
    key = (structure, offline)
    if key not in _CACHE:
        _CACHE[key] = _load_offline(structure) if offline else _load_live(structure)
    return _CACHE[key]


def last_bar_date(env: Environment) -> str | None:
    dates = sorted({pd.Timestamp(d) for p in env.panels.values() for d in p["date"]})
    return str(dates[-1].date()) if dates else None
