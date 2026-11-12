"""Indicator registry (plan §4). One entry per indicator: params schema, positional
params (how "VStop 10,2" maps to named params), compute(), the events it supports and
whether it can supply a stop. /conditions/v5 is generated from this — it never adds a
default value (D6)."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

import numpy as np
import pandas as pd

from src.indicators import tv
from src.indicators.rsi import compute_rsi
from src.indicators.vstop import wilder_atr
from src.indicators.vstop_tv import compute_vstop_tv as compute_vstop

SOURCES = ["open", "high", "low", "close"]


@dataclass(frozen=True)
class Param:
    name: str
    type: str  # int | float | enum
    label: str
    min: float | None = None
    max: float | None = None
    values: tuple[str, ...] | None = None
    optional: bool = False       # absent = the documented neutral value (never a tuned default); used for `skip`

    def payload(self) -> dict:
        d = {"name": self.name, "type": self.type, "label": self.label}
        if self.optional: d["optional"] = True
        if self.min is not None: d["min"] = self.min
        if self.max is not None: d["max"] = self.max
        if self.values: d["values"] = list(self.values)
        return d


@dataclass(frozen=True)
class Indicator:
    name: str
    label: str
    params: tuple[Param, ...]
    compute: Callable[[pd.DataFrame, dict], pd.DataFrame]  # -> frame with "value" (+ extras)
    positional_params: tuple[str, ...] = ()
    events: frozenset[str] = frozenset()
    outputs: tuple[str, ...] = ("value",)
    supports_partial_bar: bool = False
    can_supply_stop: bool = False
    min_bars_fn: Callable[[dict], int] | None = None   # indicators that stack windows (Ichimoku, 12-1 momentum, ...)

    def required_params(self) -> list[str]:
        return [p.name for p in self.params if not p.optional]

    def min_bars(self, params: dict) -> int:
        if self.min_bars_fn is not None:
            return int(self.min_bars_fn(params))
        nums = [v for v in params.values() if isinstance(v, (int, float)) and not isinstance(v, bool)]
        return int(max(nums, default=1)) + 2

    def payload(self) -> dict:
        return {
            "kind": "indicator", "name": self.name, "label": self.label,
            "required_params": [p.payload() for p in self.params],
            "positional_params": list(self.positional_params),
            "events": sorted(self.events), "outputs": list(self.outputs),
            "supports_partial_bar": self.supports_partial_bar,
            "can_supply_stop": self.can_supply_stop,
        }


def _src(df: pd.DataFrame, p: dict) -> pd.Series:
    return df[p["source"]]


def _sma(df, p):
    return pd.DataFrame({"value": _src(df, p).rolling(int(p["length"])).mean()})


def _ema(df, p):
    return pd.DataFrame({"value": tv.ema(_src(df, p).to_numpy(), int(p["length"]))}, index=df.index)


def _rsi(df, p):
    return pd.DataFrame({"value": compute_rsi(df["close"], period=int(p["length"]))})  # RSI is always on the close (as in v4)


def _vstop(df, p):
    v = compute_vstop(df, length=int(p["length"]), mult=float(p["mult"]), source=p["source"])
    return pd.DataFrame({"value": v["vstop_line"], "stop_line": v["vstop_line"], "uptrend": v["uptrend"],
                         "flip_up": v["flip_up"], "flip_down": v["flip_down"]})


def _atr(df, p):
    return pd.DataFrame({"value": tv.atr(df["high"], df["low"], df["close"], int(p["length"]))}, index=df.index)


def _macd(df, p):
    line, sig, hist = tv.macd(_src(df, p).to_numpy(), int(p["fast"]), int(p["slow"]), int(p["signal"]))
    return pd.DataFrame({"value": line, "signal": sig, "hist": hist}, index=df.index)


def _supertrend(df, p):
    line, up = tv.supertrend(df["high"], df["low"], df["close"], float(p["mult"]), int(p["length"]))
    s = pd.Series(up, index=df.index)
    valid = pd.Series(~np.isnan(line), index=df.index)
    prev = s.shift(1, fill_value=False)
    flip_up = s & ~prev & valid & valid.shift(1, fill_value=False)    # a flip needs a previous valid bar
    flip_down = ~s & prev & valid & valid.shift(1, fill_value=False)
    return pd.DataFrame({"value": line, "stop_line": line, "uptrend": s, "flip_up": flip_up, "flip_down": flip_down}, index=df.index)


def _bollinger(df, p):
    s, n = _src(df, p), int(p["length"])
    mid, sd = s.rolling(n).mean(), s.rolling(n).std(ddof=0)
    m = float(p["mult"])
    return pd.DataFrame({"value": mid, "upper": mid + m * sd, "lower": mid - m * sd})


def _skip(p) -> int:
    return int(p.get("skip") or 0)


def _volume_avg(df, p):
    return pd.DataFrame({"value": df["volume"].rolling(int(p["length"])).mean().shift(_skip(p))})


def _return_n(df, p):
    return pd.DataFrame({"value": _src(df, p).pct_change(int(p["bars"])) * 100})


def _dist_52w(df, p):
    hi = df["high"].rolling(int(p["lookback"])).max()
    return pd.DataFrame({"value": (df["close"] / hi - 1) * 100})


# ---- indicators added for the golden strategies (TradingView-compatible; oracle: tests/golden/ref_indicators.py) ----
def _bar(df, p):
    return pd.DataFrame({"value": df[p["source"]]})


def _adx(df, p):
    adx, pdi, mdi = tv.dmi(df["high"], df["low"], df["close"], int(p["length"]))
    return pd.DataFrame({"value": adx, "plus_di": pdi, "minus_di": mdi}, index=df.index)


def _ichimoku(df, p):
    t, k, a, b = tv.ichimoku(df["high"], df["low"], df["close"], int(p["tenkan"]), int(p["kijun"]), int(p["span_b"]), int(p["shift"]))
    top, bot = np.fmax(a, b), np.fmin(a, b)
    top[np.isnan(a) | np.isnan(b)] = np.nan
    bot[np.isnan(a) | np.isnan(b)] = np.nan
    return pd.DataFrame({"value": t, "tenkan": t, "kijun": k, "span_a": a, "span_b": b, "cloud_top": top, "cloud_bottom": bot}, index=df.index)


def _high_n(df, p):
    return pd.DataFrame({"value": df["high"].rolling(int(p["lookback"])).max().shift(_skip(p))})


def _low_n(df, p):
    return pd.DataFrame({"value": df["low"].rolling(int(p["lookback"])).min().shift(_skip(p))})


def _gap_up(df, p):
    """open / previous high - 1, as a fraction (0.02 = a 2% gap above yesterday's high)."""
    return pd.DataFrame({"value": df["open"] / df["high"].shift(1) - 1})


def _narrow_range(df, p):
    n = int(p["length"])
    rng = df["high"] - df["low"]
    v = (rng <= rng.rolling(n).min()).astype(float)
    v[rng.rolling(n).min().isna()] = np.nan
    return pd.DataFrame({"value": v})


def _inside_day(df, p):
    v = ((df["high"] < df["high"].shift(1)) & (df["low"] > df["low"].shift(1))).astype(float)
    v.iloc[0] = np.nan
    return pd.DataFrame({"value": v})


def _bb_squeeze(df, p):
    """1 when the Bollinger bandwidth equalled its `lookback`-bar minimum on at least one of the last `within` bars."""
    n, m = int(p["length"]), float(p["mult"])
    mid, sd = df["close"].rolling(n).mean(), df["close"].rolling(n).std(ddof=0)
    width = (2 * m * sd) / mid
    at_min = (width <= width.rolling(int(p["lookback"])).min())
    ready = width.rolling(int(p["lookback"])).min().notna()
    recent = at_min.astype(float).rolling(int(p["within"]), min_periods=1).max()
    recent[~ready] = np.nan
    return pd.DataFrame({"value": recent, "bandwidth": width}, index=df.index)


def _momentum_skip(df, p):
    """close[skip bars ago] / close[lookback bars ago] - 1, in % (12-1 momentum = lookback 252, skip 21)."""
    return pd.DataFrame({"value": (df["close"].shift(int(p["skip"])) / df["close"].shift(int(p["lookback"])) - 1) * 100})


def _turnover_avg(df, p):
    return pd.DataFrame({"value": (df["close"] * df["volume"]).rolling(int(p["length"])).mean() / 1e7})


LEN = Param("length", "int", "length", 1, 500)
SRC = Param("source", "enum", "price source", values=tuple(SOURCES))
MULT = Param("mult", "float", "multiplier", 0.1, 10.0)
CROSS = frozenset({"cross_above", "cross_below", "cross_any"})

INDICATORS: dict[str, Indicator] = {i.name: i for i in [
    Indicator("sma", "SMA", (LEN, SRC), _sma, ("length",), CROSS),
    Indicator("ema", "EMA", (LEN, SRC), _ema, ("length",), CROSS),
    Indicator("rsi", "RSI", (Param("length", "int", "length", 2, 100),), _rsi, ("length",), CROSS),
    Indicator("vstop", "VStop", (Param("length", "int", "length", 2, 100), MULT, SRC), _vstop,
              ("length", "mult"), frozenset({"flip"}) | CROSS, ("value", "stop_line"), can_supply_stop=True),
    Indicator("atr", "ATR", (Param("length", "int", "length", 1, 200),), _atr, ("length",)),
    Indicator("macd", "MACD", (Param("fast", "int", "fast length", 1, 200), Param("slow", "int", "slow length", 2, 400),
                               Param("signal", "int", "signal length", 1, 100), SRC), _macd,
              ("fast", "slow", "signal"), CROSS, ("value", "signal", "hist")),
    Indicator("supertrend", "Supertrend", (Param("length", "int", "length", 2, 100), MULT), _supertrend,
              ("length", "mult"), frozenset({"flip"}) | CROSS, ("value", "stop_line"), can_supply_stop=True),
    Indicator("bollinger", "Bollinger Bands", (LEN, MULT, SRC), _bollinger, ("length", "mult"), CROSS,
              ("value", "upper", "lower")),
    Indicator("volume_avg", "Average volume", (LEN,), _volume_avg, ("length",)),
    Indicator("return_n", "N-bar return %", (Param("bars", "int", "number of bars", 1, 500), SRC), _return_n, ("bars",)),
    Indicator("dist_52w_high", "Distance from 52-bar high %", (Param("lookback", "int", "lookback bars", 2, 1000),),
              _dist_52w, ("lookback",)),
    Indicator("bar", "Price bar", (Param("source", "enum", "bar field", values=("open", "high", "low", "close", "volume")),),
              _bar, (), frozenset(), min_bars_fn=lambda p: 1),
    Indicator("adx", "ADX", (Param("length", "int", "length", 2, 100),), _adx, ("length",), CROSS,
              ("value", "plus_di", "minus_di"), min_bars_fn=lambda p: 2 * int(p["length"]) + 1),
    Indicator("ichimoku", "Ichimoku Cloud",
              (Param("tenkan", "int", "conversion line length", 1, 200), Param("kijun", "int", "base line length", 1, 400),
               Param("span_b", "int", "span B length", 1, 400), Param("shift", "int", "cloud displacement", 1, 100)),
              _ichimoku, ("tenkan", "kijun", "span_b", "shift"), CROSS,
              ("value", "tenkan", "kijun", "span_a", "span_b", "cloud_top", "cloud_bottom"),
              min_bars_fn=lambda p: max(int(p["span_b"]), int(p["kijun"])) + int(p["shift"]) + 2),
    Indicator("high_n", "Highest high of N bars", (Param("lookback", "int", "lookback bars", 2, 1000), Param("skip", "int", "bars to skip (1 = exclude today)", 0, 5, optional=True)),
              _high_n, ("lookback",), min_bars_fn=lambda p: int(p["lookback"]) + int(p.get("skip") or 0)),
    Indicator("low_n", "Lowest low of N bars", (Param("lookback", "int", "lookback bars", 2, 1000), Param("skip", "int", "bars to skip (1 = exclude today)", 0, 5, optional=True)),
              _low_n, ("lookback",), min_bars_fn=lambda p: int(p["lookback"]) + int(p.get("skip") or 0)),
    Indicator("gap_up", "Gap above previous high", (), _gap_up, (), min_bars_fn=lambda p: 2),
    Indicator("narrow_range", "Narrowest range of N bars (NR7 = 7)", (Param("length", "int", "bars", 2, 50),), _narrow_range,
              ("length",)),
    Indicator("inside_day", "Inside bar", (), _inside_day, (), min_bars_fn=lambda p: 2),
    Indicator("bb_squeeze", "Bollinger squeeze (bandwidth at its N-bar low)",
              (LEN, MULT, Param("lookback", "int", "lookback bars", 2, 1000), Param("within", "int", "within the last N bars", 1, 100)),
              _bb_squeeze, ("length", "mult"), frozenset(), ("value", "bandwidth"),
              min_bars_fn=lambda p: int(p["length"]) + int(p["lookback"]) + 1),
    Indicator("momentum_skip", "Return skipping recent bars (12-1 momentum)",
              (Param("lookback", "int", "bars back", 2, 1000), Param("skip", "int", "recent bars to skip", 0, 500)),
              _momentum_skip, ("lookback", "skip"), min_bars_fn=lambda p: int(p["lookback"]) + 1),
    Indicator("turnover_avg", "Average traded value (cr)", (LEN,), _turnover_avg, ("length",)),
]}

FIELDS = [
    {"kind": "field", "name": "mcap_cr", "label": "Market cap (cr)", "required_params": []},
    {"kind": "field", "name": "traded_value_cr", "label": "Median traded value (cr)",
     "required_params": [{"name": "window", "type": "week_window_str", "label": "window", "min": "1W", "max": "52W"}]},
    {"kind": "field", "name": "price", "label": "Price", "required_params": []},
    {"kind": "field", "name": "volume", "label": "Volume", "required_params": []},
    {"kind": "field", "name": "sector", "label": "Sector", "required_params": []},
    {"kind": "field", "name": "rs_rating", "label": "RS rating (percentile of N-bar return within the universe)",
     "required_params": [{"name": "lookback", "type": "int", "label": "lookback bars", "min": 20, "max": 1000}]},
]

OPS = [">", ">=", "<", "<=", "==", "between", "outside", "flip", "cross_above", "cross_below",
       "cross_any", "rising", "falling", "up_over", "down_over"]


def conditions_payload() -> dict:
    return {"fields": FIELDS, "indicators": [i.payload() for i in INDICATORS.values()], "ops": OPS,
            "timeframes": ["1D", "1W", "1M"]}


def check_params(ind: Indicator, params: dict) -> list[str]:
    """Missing / out-of-range params. Never fills a default."""
    errs = []
    for p in ind.params:
        v = params.get(p.name)
        if v is None and p.optional:
            continue
        if v is None:
            errs.append(f"missing required param '{p.name}'")
        elif p.type == "enum" and v not in (p.values or ()):
            errs.append(f"param '{p.name}' must be one of {list(p.values or ())}")
        elif p.type in ("int", "float"):
            if not isinstance(v, (int, float)) or isinstance(v, bool):
                errs.append(f"param '{p.name}' must be a number")
            elif (p.min is not None and v < p.min) or (p.max is not None and v > p.max):
                errs.append(f"param '{p.name}' must be within [{p.min}, {p.max}]")
    return errs
