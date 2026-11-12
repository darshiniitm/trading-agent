"""ScreenProgram v5 — the IR the prompt compiler targets (docs/prompt-compiler-any-prompt-plan.md §2).

Paths are keyed by ids (conditions.C3.params.length), never array positions.
Unknown keys are rejected so a compiler typo can't silently become a no-op.
"""
from __future__ import annotations

import typing
from typing import Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator

TF = Literal["1D", "1W", "1M"]
OPS = {">", ">=", "<", "<=", "==", "between", "outside", "flip", "cross_above", "cross_below",
       "cross_any", "rising", "falling", "up_over", "down_over"}
EVENT_OPS = {"flip", "cross_above", "cross_below", "cross_any"}


class _M(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Universe(_M):
    source: Literal["nse_all", "index", "list"]
    index: str | None = None
    list_: str | None = Field(default=None, alias="list")  # e.g. "niftyindices_csv"
    symbols: "typing.List[str] | None" = None
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class FieldOperand(_M):
    field: Literal["mcap_cr", "traded_value_cr", "price", "volume", "sector", "rs_rating"]
    params: dict[str, Any] = Field(default_factory=dict)


class IndOperand(_M):
    ind: str
    params: dict[str, Any] = Field(default_factory=dict)
    tf: TF
    output: str | None = None  # which series of a multi-output indicator (macd "signal", ...)


Operand = Union[FieldOperand, IndOperand]


class Condition(_M):
    id: str
    lhs: Operand
    op: str
    value: Any = None
    rhs: IndOperand | None = None
    rhs_mult: float | None = Field(default=None, gt=0)   # compare against rhs (or value) x this: "close >= 1.30 x lowest low"
    dir: Literal["long", "short"] | None = None
    within_bars: int | None = Field(default=None, ge=1)
    bars: int | None = Field(default=None, ge=1)
    emit: list[Literal["direction", "event_date"]] | None = None
    phrase: str | None = None  # the condition's own words (compiler provenance; unused by the evaluator)

    @model_validator(mode="after")
    def _op_known(self):
        if self.op not in OPS:
            raise ValueError(f"unknown op {self.op!r}")
        return self


class T1Window(_M):
    length_sessions: int = Field(ge=1)
    offsets: list[int]


class EvalSpec(_M):
    mode: Literal["literal", "t1_literal", "latest"] = "literal"
    timeframe: TF | None = None
    bar: Literal["last_completed"] = "last_completed"
    t1_window: T1Window | None = None


class NearMiss(_M):
    max_failed: int = Field(ge=0)


class SetDef(_M):
    id: str
    from_: str = Field(alias="from")
    label: str | None = None
    eval: EvalSpec | None = None
    where: Any  # {"all": [...]} | {"any": [...]} | {"not": ...}; leaves are condition ids
    near_miss: NearMiss | None = None
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class Action(BaseModel):
    """Actions carry type-specific fields; validated per type in the actions module."""
    model_config = ConfigDict(extra="allow")
    id: str
    type: Literal["group_by", "rank", "trade_plan", "validate", "limit"]


class ScreenProgram(_M):
    program_version: Literal[5]
    universe: Universe
    sets: list[SetDef]
    conditions: list[Condition]
    actions: list[Action] = Field(default_factory=list)
    source_phrases: list[dict] = Field(default_factory=list)
    needs_input: list[dict] = Field(default_factory=list)
    unsupported: list[dict] = Field(default_factory=list)
    ignored: list[dict] = Field(default_factory=list)
    unrecognised: list[dict] = Field(default_factory=list)
    answers: list[dict] = Field(default_factory=list)

    @model_validator(mode="after")
    def _refs(self):
        cids = [c.id for c in self.conditions]
        sids = [s.id for s in self.sets]
        if len(set(cids)) != len(cids) or len(set(sids)) != len(sids):
            raise ValueError("condition and set ids must be unique")
        known_sets = {"universe", *sids}
        for s in self.sets:
            if s.from_ not in known_sets:
                raise ValueError(f"set {s.id} is from unknown set {s.from_!r}")
            for leaf in where_leaves(s.where):
                if leaf not in cids:
                    raise ValueError(f"set {s.id} references unknown condition {leaf!r}")
        return self


def where_leaves(node: Any) -> list[str]:
    if isinstance(node, str):
        return [node]
    if isinstance(node, dict):
        out: list[str] = []
        for key in ("all", "any"):
            for child in node.get(key, []) or []:
                out += where_leaves(child)
        if "not" in node:
            child = node["not"]
            out += [x for c in (child if isinstance(child, list) else [child]) for x in where_leaves(c)]
        return out
    return []
