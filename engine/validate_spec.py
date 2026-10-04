from __future__ import annotations

from typing import NamedTuple

from engine.conditions.catalog import CATALOG
from engine.schemas import ScreenSpec


class SpecError(NamedTuple):
    condition_id: str | None
    message: str


def _check_condition(cond) -> list[SpecError]:
    key = f"{cond.kind}:{cond.name}"
    entry = CATALOG.get(key)
    if entry is None:
        return [SpecError(cond.id, f"unsupported: {key} is not a condition this engine can compute")]

    errors: list[SpecError] = []
    for p in entry["required_params"]:
        name = p["name"]
        if name not in cond.params:
            errors.append(SpecError(cond.id, f"missing required param '{name}' for {key}"))
            continue
        val = cond.params[name]
        if p["type"] in ("int", "float") and not (p["min"] <= val <= p["max"]):
            errors.append(SpecError(cond.id, f"param '{name}'={val} out of range [{p['min']}, {p['max']}] for {key}"))
        if p["type"] == "enum" and val not in p["values"]:
            errors.append(SpecError(cond.id, f"param '{name}'={val!r} not one of {p['values']} for {key}"))

    valid_ops = {o["op"] for o in entry["ops"]}
    if cond.op not in valid_ops:
        errors.append(SpecError(cond.id, f"op '{cond.op}' not supported for {key} (supported: {sorted(valid_ops)})"))
    return errors


def validate_spec(spec: ScreenSpec) -> list[SpecError]:
    errors: list[SpecError] = []
    for cond in spec.conditions:
        errors.extend(_check_condition(cond))

    if spec.stop is not None:
        stop_cond = next((c for c in spec.conditions if c.id == spec.stop.from_), None)
        if stop_cond is None:
            errors.append(SpecError(None, f"stop.from '{spec.stop.from_}' does not match any condition id"))
        elif not (stop_cond.kind == "indicator" and stop_cond.name == "vstop"):
            errors.append(SpecError(stop_cond.id, "stop must reference a vstop indicator condition"))

    has_event = any(c.role == "event" for c in spec.conditions)
    if spec.structure == "t1_literal" and has_event and spec.t1_window is None:
        errors.append(SpecError(None, "t1_literal with an event condition requires t1_window"))

    return errors
