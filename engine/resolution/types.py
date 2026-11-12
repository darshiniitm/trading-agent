"""Core types for the data-resolution layer (docs/data-fallback-spec.md §3.1, §5.2)."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from enum import Enum
from typing import Any, Literal, Protocol

import pandas as pd

Quality = Literal["ok", "fallback", "stale", "approx", "missing"]


class DataType(str, Enum):
    UNIVERSE = "UNIVERSE"
    OHLCV = "OHLCV"
    MCAP = "MCAP"
    SECTOR = "SECTOR"
    CORP_ACTIONS = "CORP_ACTIONS"


class Reason(str, Enum):
    """Closed list of reason codes (§5.2). Add new ones here, not ad hoc."""
    NO_DATA = "no_data"
    INSUFFICIENT_HISTORY = "insufficient_history"
    STALE_DATA = "stale_data"
    APPROX_INPUT = "approx_input"
    PARTIAL_FIELDS = "partial_fields"
    UNADJUSTED_PRICES = "unadjusted_prices"
    SURVIVORSHIP_RISK = "survivorship_risk"
    PRICE_MISMATCH = "price_mismatch"
    CONDITION_UNFEEDABLE = "condition_unfeedable"


# Only these produce a `?` state; the rest attach as warnings to a 1/0 (§5.2 note).
UNKNOWN_REASONS = {Reason.NO_DATA, Reason.INSUFFICIENT_HISTORY, Reason.PARTIAL_FIELDS, Reason.CONDITION_UNFEEDABLE}

QUALITY_RANK = {"ok": 0, "fallback": 1, "stale": 2, "approx": 3, "missing": 4}


def worst_quality(*qs: str) -> str:
    return max(qs, key=QUALITY_RANK.__getitem__) if qs else "ok"


@dataclass
class DataRequest:
    data_type: DataType
    as_of: date
    key: str | None = None                      # index name / symbol
    symbols: list[str] | None = None
    params: dict = field(default_factory=dict)  # e.g. {"mcap": Series}, {"user_id":.., "prompt_id":..}


@dataclass
class ProviderResult:
    value: Any
    as_of: date                                  # date the data represents (not fetch time)
    quality: Quality = "ok"                      # provider's own judgement (e.g. stale / approx)
    reason: Reason | None = None
    source: str | None = None                    # override of provider name, e.g. "cache:niftyindices"
    meta: dict = field(default_factory=dict)


class ProviderError(Exception):
    """A provider could not serve the request. Never propagates out of the resolver."""
    def __init__(self, msg: str, reason: Reason = Reason.NO_DATA):
        super().__init__(msg)
        self.reason = reason


class Provider(Protocol):
    name: str
    data_type: DataType
    # True if a hit from this provider is "first-priority" (quality ok). Set by chain position.
    def fetch(self, request: DataRequest) -> ProviderResult: ...


@dataclass
class ResolvedData:
    value: Any
    source: str
    as_of: date | None
    fetched_at: datetime
    quality: Quality
    reason: str | None = None
    chain_trace: list[str] = field(default_factory=list)
    meta: dict = field(default_factory=dict)

    @property
    def missing(self) -> bool:
        return self.quality == "missing"
