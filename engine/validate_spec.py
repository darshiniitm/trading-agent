from __future__ import annotations

import re
from typing import NamedTuple

from engine.conditions.catalog import CATALOG
from engine.schemas import ScreenSpec

_WEEK_WINDOW_RE = re.compile(r"^[1-9][0-9]*W$")


class SpecError(NamedTuple):
    condition_id: str | None
    message: str


def _check_param_type(p: dict, val) -> bool:
    """True iff `val`'s Python type matches what the catalog declares for this param.
    Checked BEFORE any range/pattern comparison (Fix 4d) -- `p["min"] <= val <= p["max"]`
    raises TypeError on a non-comparable type (e.g. a string where an int/float is
    expected), which must become a clean SpecError, not a crash."""
    t = p["type"]
    if t == "int":
        return isinstance(val, int) and not isinstance(val, bool)
    if t == "float":
        return isinstance(val, (int, float)) and not isinstance(val, bool)
    if t == "enum":
        return isinstance(val, str)
    if t == "week_window_str":
        return isinstance(val, str)
    return True


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

        # (d) type check first -- a wrong-typed param (e.g. a string where int/float is
        # expected) must produce a clean SpecError, never a TypeError from the
        # range/pattern comparisons below.
        if not _check_param_type(p, val):
            errors.append(SpecError(cond.id, f"param '{name}' must be of type {p['type']} for {key}, got {val!r}"))
            continue

        if p["type"] in ("int", "float") and not (p["min"] <= val <= p["max"]):
            errors.append(SpecError(cond.id, f"param '{name}'={val} out of range [{p['min']}, {p['max']}] for {key}"))
        if p["type"] == "enum" and val not in p["values"]:
            errors.append(SpecError(cond.id, f"param '{name}'={val!r} not one of {p['values']} for {key}"))
        # (c) a week-window string ("8W") must be a positive integer followed by 'W' --
        # no leading zero, no empty string, no other suffix. Previously this either
        # 500'd (int() parse failure, e.g. "abc"/"8M"/"") or silently scored 0
        # candidates with no error ("0W").
        if p["type"] == "week_window_str" and not _WEEK_WINDOW_RE.match(val):
            errors.append(SpecError(
                cond.id, f"param '{name}' must be a positive integer followed by 'W' (e.g. '8W'), got {val!r}"))

    valid_ops = {o["op"] for o in entry["ops"]}
    if cond.op not in valid_ops:
        errors.append(SpecError(cond.id, f"op '{cond.op}' not supported for {key} (supported: {sorted(valid_ops)})"))
        return errors

    op_entry = next(o for o in entry["ops"] if o["op"] == cond.op)

    # (a) requires_value is declared in the catalog but was never read anywhere in
    # engine/ -- a condition whose op requires a value shape ([min, max] for "between",
    # a plain number for ">=") but carries value=None (or the wrong shape) previously
    # passed validation and 500'd downstream (engine/conditions/evaluate.py unpacking
    # `lo, hi = cond.value` or comparing `value >= None`).
    if op_entry["requires_value"]:
        value_ok = True
        if cond.value is None:
            value_ok = False
        elif cond.op == "between":
            value_ok = isinstance(cond.value, (list, tuple)) and len(cond.value) == 2
        elif cond.op == ">=":
            value_ok = isinstance(cond.value, (int, float)) and not isinstance(cond.value, bool)
        if not value_ok:
            errors.append(SpecError(
                cond.id, f"op '{cond.op}' requires a value in the shape {op_entry['value_shape']}"))

    # (b) `dir` is never validated for flip ops -- a vstop flip condition with dir=None
    # (or anything but "long") previously passed validation and silently produced ZERO
    # full_match candidates with no error (evaluate.py's `passed = ... if cond.dir ==
    # "long" else False`).
    if cond.op == "flip" and cond.dir != "long":
        errors.append(SpecError(cond.id, "flip op requires dir='long' (no other direction supported yet)"))

    return errors


def validate_spec(spec: ScreenSpec) -> list[SpecError]:
    errors: list[SpecError] = []
    for cond in spec.conditions:
        errors.extend(_check_condition(cond))

    # Fix 3: the "stop must reference a vstop indicator condition" check already exists
    # below, but nothing parallel existed for role == "event" -- a condition like
    # {"role": "event", "kind": "indicator", "name": "rsi", ...} passed validation with
    # zero errors, then crashed downstream (engine/screen.py and engine/selection.py both
    # assume an event condition's computed value is a dict with an "uptrend" key, which
    # is only true for vstop).
    for cond in spec.conditions:
        if cond.role == "event" and not (cond.kind == "indicator" and cond.name == "vstop"):
            errors.append(SpecError(
                cond.id, "event conditions must reference a vstop indicator (no other partial-bar event type is supported yet)"))

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
