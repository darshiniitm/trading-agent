from __future__ import annotations

from engine.schemas import ScreenSpec

STRUCTURES: dict[str, dict] = {
    "literal": {
        "structure": "literal",
        "steps": [
            "evaluate_on_completed_weekly_bar",
            "event_recheck_at_selection_point",
            "ep_at_selection_point",
            "sl_from_stop",
            "risk_cap_rejection",
            "sector_display",
            "validation_1_2_3w",
        ],
        "event_window": "friday_bar_only",
    },
    "t1_literal": {
        "structure": "t1_literal",
        "steps": [
            "evaluate_on_completed_weekly_bar",
            "event_detection_window",
            "event_recheck_at_selection_point",
            "ep_at_selection_point",
            "sl_from_stop",
            "risk_cap_rejection",
            "sector_display",
            "validation_1_2_3w",
            "t1_fields",
        ],
        "event_window": "user_t1_window",
    },
}


def structures_payload() -> list[dict]:
    return list(STRUCTURES.values())


def _has_event_condition(spec: ScreenSpec) -> bool:
    return any(c.role == "event" for c in spec.conditions)


def applied_steps(spec: ScreenSpec) -> list[dict]:
    has_event = _has_event_condition(spec)
    has_selection_point = spec.selection_point is not None
    has_stop = spec.stop is not None

    steps = [
        {"step": "evaluate_on_completed_weekly_bar", "applied": True, "reason": None},
        {"step": "event_recheck_at_selection_point",
         "applied": has_event and has_selection_point,
         "reason": None if has_event else "no event condition in spec"},
        {"step": "ep_at_selection_point",
         "applied": has_selection_point,
         "reason": None if has_selection_point else "no selection point given"},
        {"step": "sl_from_stop",
         "applied": has_stop,
         "reason": None if has_stop else "no stop in spec"},
        {"step": "risk_cap_rejection",
         "applied": spec.risk_cap_pct is not None,
         "reason": None if spec.risk_cap_pct is not None else "no risk_cap_pct in spec"},
        {"step": "sector_display", "applied": True, "reason": None},
        {"step": "validation_1_2_3w", "applied": True, "reason": None},
    ]
    if spec.structure == "t1_literal":
        steps.insert(1, {
            "step": "event_detection_window",
            "applied": has_event and spec.t1_window is not None,
            "reason": None if has_event else "no event condition — t1_literal behaves like literal",
        })
        steps.append({
            "step": "t1_fields", "applied": has_event and spec.t1_window is not None,
            "reason": None if has_event else "no event condition in spec",
        })
    return steps
