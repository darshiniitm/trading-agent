import numpy as np
import pandas as pd

from engine.v5.data import DataContext

SAMPLE_ANSWERED = {  # the 07 Oct sample prompt with every question answered (trade set = qualified)
    "program_version": 5,
    "universe": {"source": "nse_all"},
    "sets": [
        {"id": "S1", "from": "universe", "label": "mcap", "where": {"all": ["C1"]}},
        {"id": "S2", "from": "S1", "label": "qualified", "eval": {"mode": "literal", "timeframe": "1W"},
         "where": {"all": ["C2", "C3"]}},
        {"id": "S3", "from": "S1", "label": "flipped", "eval": {"mode": "literal", "timeframe": "1W"},
         "where": {"all": ["C2"]}},
    ],
    "conditions": [
        {"id": "C1", "lhs": {"field": "mcap_cr"}, "op": "between", "value": [10000, 50000]},
        {"id": "C2", "lhs": {"ind": "vstop", "params": {"length": 10, "mult": 2, "source": "close"}, "tf": "1W"},
         "op": "flip", "dir": "long", "within_bars": 1},
        {"id": "C3", "lhs": {"ind": "rsi", "params": {"length": 14}, "tf": "1W"},
         "op": "between", "value": [50, 65]},
    ],
    "actions": [
        {"id": "A1", "type": "group_by", "set": "S2", "key": "sector",
         "highlight": {"metric": "sector_return_vs_benchmark", "lookback_weeks": 4, "rule": {"rs_gt": 0.0, "top_k": 3}}},
        {"id": "A2", "type": "trade_plan", "set": "S2", "entry": {"at": "signal_close"},
         "stop": {"from": "C2"}, "confidence": {"method": "conditions_met_count"}},
        {"id": "A3", "type": "validate", "of": "program", "shift": {"weeks": -1}, "horizons_w": [1]},
    ],
}


def daily(closes, start="2023-01-02", vol=1_000_000.0, spread=0.01):
    closes = np.asarray(closes, dtype=float)
    n = len(closes)
    return pd.DataFrame({
        "date": pd.bdate_range(start, periods=n), "open": closes, "high": closes * (1 + spread),
        "low": closes * (1 - spread), "close": closes, "volume": np.full(n, vol),
    })


def ctx_for(panels: dict, sectors: dict | None = None, shares: float = 1e9, **kw) -> DataContext:
    tick = list(panels)
    uni = pd.DataFrame({"ticker": tick, "name": tick, "sector": [(sectors or {}).get(t, "Tech") for t in tick]})
    return DataContext(uni, {t: shares for t in tick}, panels, **kw)


def literal_program(next_open: bool = True) -> dict:
    """The Literal arm's brief as a v5 program: mcap + liquidity + weekly VStop flip + RSI band, one set,
    a trade plan whose stop comes from the VStop."""
    return {
        "program_version": 5, "universe": {"source": "nse_all"},
        "sets": [{"id": "S1", "from": "universe", "label": "literal", "eval": {"mode": "literal", "timeframe": "1W", "bar": "last_completed"},
                  "where": {"all": ["C1", "C2", "C3", "C4"]}}],
        "conditions": [
            {"id": "C1", "lhs": {"field": "mcap_cr"}, "op": "between", "value": [10000, 50000]},
            {"id": "C2", "lhs": {"field": "traded_value_cr", "params": {"window": "8W"}}, "op": ">=", "value": 10},
            {"id": "C3", "lhs": {"ind": "vstop", "params": {"length": 10, "mult": 2, "source": "close"}, "tf": "1W"}, "op": "flip", "dir": "long", "within_bars": 1},
            {"id": "C4", "lhs": {"ind": "rsi", "params": {"length": 14}, "tf": "1W"}, "op": "between", "value": [50, 65]},
        ],
        "actions": [{"id": "A1", "type": "trade_plan", "set": "S1", "entry": {"at": "next_open" if next_open else "signal_close"},
                     "stop": {"from": "C3"}, "confidence": {"method": "conditions_met_count"}}],
    }
