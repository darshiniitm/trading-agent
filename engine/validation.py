from __future__ import annotations

import pandas as pd

from src.backtest.horizons import grade_horizons

FIRST_LOOK_WEEKS = 13
REAL_READ_WEEKS = 26


class ValidationSpecError(Exception):
    pass


def _maturity(graded_weeks_so_far: int) -> str:
    if graded_weeks_so_far >= REAL_READ_WEEKS:
        return "real_read"
    if graded_weeks_so_far >= FIRST_LOOK_WEEKS:
        return "first_look"
    return "not_first_look"


def validate_arm(prompt_id: int, env, picks: list[dict], as_of: pd.Timestamp,
                  graded_weeks_so_far: int, horizons: list[int] = (1, 2, 3),
                  vstop_params: dict | None = None) -> dict:
    maturity = _maturity(graded_weeks_so_far)
    if maturity == "not_first_look":
        return {"graded_weeks": graded_weeks_so_far, "maturity": maturity, "rows": []}

    if vstop_params is None:
        raise ValidationSpecError(
            "cannot grade horizons without the stop condition's own vstop params "
            "(stop.from must reference a vstop indicator condition — enforced at /screen time)"
        )

    rule_spec = {"signals": [{"id": "vstop_flip", "params": vstop_params}]}
    rows = grade_horizons(picks, env.panels, as_of, list(horizons), bench=None,
                           rule_spec=rule_spec, daily_panels=env.daily_panels)
    return {"graded_weeks": graded_weeks_so_far, "maturity": maturity, "rows": rows}
