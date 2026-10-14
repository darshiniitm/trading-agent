from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


class Condition(BaseModel):
    id: str
    role: Literal["filter", "event", "stop"]
    kind: Literal["field", "indicator"]
    name: str
    params: dict[str, Any] = Field(default_factory=dict)
    op: str
    value: Any = None
    dir: Literal["long"] | None = None  # only meaningful for op == "flip"


class SelectionPoint(BaseModel):
    session_of_week: int = Field(ge=1, le=5)
    at: Literal["open", "close"]


class Stop(BaseModel):
    from_: str = Field(alias="from")

    model_config = {"populate_by_name": True}


class NearMiss(BaseModel):
    max_failed: int = Field(ge=0)


class T1Window(BaseModel):
    length_sessions: int = Field(ge=1)
    offsets: list[int]


class ScreenSpec(BaseModel):
    spec_version: int
    structure: Literal["literal", "t1_literal"]
    timeframe: Literal["1W"]
    selection_point: SelectionPoint | None = None
    conditions: list[Condition]
    stop: Stop | None = None
    risk_cap_pct: float | None = None
    near_miss: NearMiss | None = None
    t1_window: T1Window | None = None

    @field_validator("conditions")
    @classmethod
    def _unique_condition_ids(cls, v: list[Condition]) -> list[Condition]:
        ids = [c.id for c in v]
        if len(ids) != len(set(ids)):
            raise ValueError("condition ids must be unique")
        return v
