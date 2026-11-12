"""Capability registry (spec §6.1): which RAW inputs each parameter needs. Indicators are always computed locally
from OHLCV, so only raw inputs appear here."""
from __future__ import annotations

from engine.resolution.types import DataType
from engine.v5.program import Condition, FieldOperand, IndOperand

_OHLC_ALL = {"OHLCV.high", "OHLCV.low", "OHLCV.close"}
_BY_INDICATOR = {                       # indicators whose inputs do not depend on a `source` param
    "rsi": {"OHLCV.close"}, "vstop": _OHLC_ALL, "supertrend": _OHLC_ALL, "atr": _OHLC_ALL,
    "volume_avg": {"OHLCV.volume"}, "dist_52w_high": {"OHLCV.high", "OHLCV.close"},
    "adx": _OHLC_ALL, "ichimoku": _OHLC_ALL, "high_n": {"OHLCV.high"}, "low_n": {"OHLCV.low"},
    "gap_up": {"OHLCV.open", "OHLCV.high"}, "narrow_range": {"OHLCV.high", "OHLCV.low"},
    "inside_day": {"OHLCV.high", "OHLCV.low"}, "bb_squeeze": {"OHLCV.close"}, "momentum_skip": {"OHLCV.close"},
    "turnover_avg": {"OHLCV.close", "OHLCV.volume"},
}
_BY_FIELD = {
    "price": {"OHLCV.close"}, "volume": {"OHLCV.volume"}, "mcap_cr": {"MCAP", "OHLCV.close"},
    "traded_value_cr": {"OHLCV.close", "OHLCV.volume"}, "sector": {"SECTOR"},
    "rs_rating": {"OHLCV.close"},
}
_DATA_TYPE = {"MCAP": DataType.MCAP, "SECTOR": DataType.SECTOR, "UNIVERSE": DataType.UNIVERSE}


def operand_requires(o) -> set[str]:
    if isinstance(o, FieldOperand):
        return set(_BY_FIELD.get(o.field, set()))
    if isinstance(o, IndOperand):
        if o.ind in _BY_INDICATOR:
            return set(_BY_INDICATOR[o.ind])
        src = (o.params or {}).get("source", "close")
        return {f"OHLCV.{src}"}
    return set()


def condition_requires(c: Condition) -> set[str]:
    out = operand_requires(c.lhs)
    if c.rhs is not None:
        out |= operand_requires(c.rhs)
    return out


def required_ohlcv_fields(c: Condition) -> set[str]:
    return {r.split(".", 1)[1] for r in condition_requires(c) if r.startswith("OHLCV.")}


def required_data_types(c: Condition) -> set[DataType]:
    return {DataType.OHLCV if r.startswith("OHLCV.") else _DATA_TYPE[r] for r in condition_requires(c)}
