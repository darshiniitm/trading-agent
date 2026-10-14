from __future__ import annotations

import pandas as pd

from src.backtest.horizons import grade_horizons
from src.indicators.vstop import compute_vstop
from src.screen.engine import _slice_as_of

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


def _is_weekly_uptrend(panel: pd.DataFrame | None, as_of: pd.Timestamp, vstop_params: dict) -> bool:
    """True only when the ticker's own weekly panel, point-in-time sliced to `as_of`, is
    in a VStop uptrend there -- i.e. the weekly line could actually have been a real
    resting stop order at that date. A t1_literal event fires on DAILY bars and can do so
    while the WEEKLY trend is still down at the same `as_of` (the weekly line then sits
    above entry); grading that pick against the weekly line would fabricate a stop-out
    loss against a stop that was never actually resting in the market (Fix 2). A missing
    or too-short panel is treated the same as a downtrend: not gradable, never defaulted
    to "passes"."""
    if panel is None or panel.empty:
        return False
    sliced = _slice_as_of(panel, pd.Timestamp(as_of))
    min_bars = vstop_params.get("length", 10) + 1
    if len(sliced) < min_bars:
        return False
    vdf = compute_vstop(sliced, **vstop_params)
    if vdf.empty:
        return False
    return bool(vdf.iloc[-1]["uptrend"])


def _not_gradable_rows(ticker: str, as_of: pd.Timestamp, horizons: list[int],
                        entry_price: float | None) -> list[dict]:
    as_of_str = str(pd.Timestamp(as_of).date())
    return [{
        "ticker": ticker,
        "signal_week_start": as_of_str,
        "horizon_weeks": h,
        "status": "not_gradable_weekly_downtrend",
        "buy_price": entry_price,
    } for h in horizons]


def validate_arm(prompt_id: int, env, picks: list[dict], as_of: pd.Timestamp,
                  graded_weeks_so_far: int, horizons: list[int] = (1, 2, 3),
                  vstop_params: dict | None = None, structure: str = "literal") -> dict:
    maturity = _maturity(graded_weeks_so_far)
    if maturity == "not_first_look":
        return {"graded_weeks": graded_weeks_so_far, "maturity": maturity, "rows": []}

    if vstop_params is None:
        raise ValidationSpecError(
            "cannot grade horizons without the stop condition's own vstop params "
            "(stop.from must reference a vstop indicator condition — enforced at /screen time)"
        )

    horizons = list(horizons)
    as_of = pd.Timestamp(as_of)

    # Fix 2: for t1_literal, a pick whose weekly trend is down at `as_of` never had a
    # real resting weekly stop -- route it to its own "not gradable" rows instead of
    # grade_horizons (which only knows the weekly-resolution stop and would fabricate a
    # stop-out). For `literal`, every pick is a weekly-uptrend survivor by construction,
    # so this can't happen and behavior is unchanged.
    gradable_picks = picks
    extra_rows: list[dict] = []
    if structure == "t1_literal":
        gradable_picks = []
        for p in picks:
            panel = env.panels.get(p["ticker"]) if env is not None and env.panels else None
            if _is_weekly_uptrend(panel, as_of, vstop_params):
                gradable_picks.append(p)
            else:
                extra_rows.extend(_not_gradable_rows(p["ticker"], as_of, horizons, p.get("entry_price")))

    # Fix 1: grade_horizons (src/backtest/horizons.py) expects pick["EP"]/pick["SL"]
    # (uppercase). Every pick this engine produces (select_candidates, write_record) is
    # lowercase, and carries TWO EP-like fields: `ep` (the screen-time weekly close --
    # never a real fill) and `entry_price` (the actual selection-point fill, set by
    # select_candidates). Always use `entry_price` here, never `ep` -- grading against
    # the screen-time draft would silently corrupt the evidence this project depends on.
    normalized = [{"ticker": p["ticker"], "EP": p["entry_price"], "SL": p["sl"]} for p in gradable_picks]

    rule_spec = {"signals": [{"id": "vstop_flip", "params": vstop_params}]}
    rows = grade_horizons(normalized, env.panels, as_of, horizons, bench=None,
                           rule_spec=rule_spec, daily_panels=env.daily_panels)
    return {"graded_weeks": graded_weeks_so_far, "maturity": maturity, "rows": extra_rows + rows}
