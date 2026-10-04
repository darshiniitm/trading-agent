from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pandas as pd

from src.indicators.rsi import compute_rsi
from src.indicators.vstop import compute_vstop
from src.screen.engine import _slice_as_of

CR = 1e7


@dataclass
class TickerEval:
    values: dict[str, Any] = field(default_factory=dict)
    passed: dict[str, bool] = field(default_factory=dict)
    failed_ids: list[str] = field(default_factory=list)
    all_passed: bool = True
    last_bar: dict = field(default_factory=dict)


def _warmup_bars_needed(conditions) -> int:
    needed = 1
    for c in conditions:
        if c.kind == "indicator" and c.name == "vstop":
            needed = max(needed, c.params["length"] + 1)
        if c.kind == "indicator" and c.name == "rsi":
            needed = max(needed, c.params["length"] + 1)
    return needed


def _eval_field(name: str, params: dict, panel: pd.DataFrame, shares: float | None,
                 bars_per_week: int) -> float | None:
    last = panel.iloc[-1]
    if name == "mcap_cr":
        if not shares:
            return None
        return round(float(last["close"]) * shares / CR, 4)
    if name == "traded_value_cr":
        window = params["window"]  # e.g. "8W"
        weeks = int(window.rstrip("Ww"))
        bars = weeks * bars_per_week
        turnover = (panel["close"] * panel["volume"]).tail(bars) / CR
        if len(turnover) == 0:
            return None
        return round(float(turnover.median()), 4)
    raise ValueError(f"unknown field condition: {name}")


def _eval_indicator(cond, panel: pd.DataFrame) -> tuple[Any, bool]:
    if cond.name == "vstop":
        p = cond.params
        vdf = compute_vstop(panel, length=p["length"], mult=p["mult"], source=p["source"])
        last = vdf.iloc[-1]
        value = {"vstop_line": None if pd.isna(last["vstop_line"]) else float(last["vstop_line"]),
                  "uptrend": bool(last["uptrend"])}
        passed = bool(last["flip_up"]) if cond.dir == "long" else False
        return value, passed
    if cond.name == "rsi":
        p = cond.params
        rsi_series = compute_rsi(panel["close"], period=p["length"])
        last_rsi = rsi_series.iloc[-1]
        value = None if pd.isna(last_rsi) else round(float(last_rsi), 4)
        lo, hi = cond.value
        passed = value is not None and lo <= value <= hi
        return value, passed
    raise ValueError(f"unknown indicator condition: {cond.name}")


def evaluate_ticker(panel: pd.DataFrame, shares: float | None, conditions: list,
                     as_of: pd.Timestamp, bars_per_week: int = 1) -> TickerEval | None:
    panel = _slice_as_of(panel, pd.Timestamp(as_of))
    if len(panel) < _warmup_bars_needed(conditions):
        return None

    result = TickerEval()
    last = panel.iloc[-1]
    result.last_bar = {
        "close": float(last["close"]), "open": float(last["open"]),
        "high": float(last["high"]), "low": float(last["low"]),
        "volume": float(last["volume"]), "date": last["date"],
    }

    for cond in conditions:
        if cond.kind == "field":
            value = _eval_field(cond.name, cond.params, panel, shares, bars_per_week)
            # Field ops are not all "between" (e.g. traded_value_cr is ">=" with a
            # scalar value) -- branch on cond.op rather than assuming a [lo, hi] shape.
            if cond.op == "between":
                lo, hi = cond.value
                passed = value is not None and lo <= value <= hi
            elif cond.op == ">=":
                passed = value is not None and value >= cond.value
            else:
                raise ValueError(f"unsupported op for field condition {cond.name!r}: {cond.op}")
        else:
            value, passed = _eval_indicator(cond, panel)

        result.values[cond.id] = value
        if cond.role == "stop":
            continue  # a stop condition supplies a value; it is never itself pass/fail
        result.passed[cond.id] = passed
        if not passed:
            result.failed_ids.append(cond.id)

    result.all_passed = len(result.failed_ids) == 0
    return result
