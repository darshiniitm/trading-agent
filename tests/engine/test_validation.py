import pandas as pd
import pytest

from engine.env import Environment
from engine.validation import validate_arm
from tests.offline import make_panel


def test_validate_reports_not_first_look_under_13_weeks(literal_env):
    picks = [{"ticker": "AAA.NS", "EP": 100.0, "SL": 90.0}]
    result = validate_arm(prompt_id=12, env=literal_env, picks=picks,
                           as_of=pd.Timestamp("2026-01-05"), graded_weeks_so_far=3)
    assert result["maturity"] == "not_first_look"
    assert result["rows"] == []


def test_validate_reports_first_look_at_13_weeks(literal_env):
    # NOTE (deviation from the brief's literal Step 1 test): the brief's own sample
    # call omits `vstop_params`, but the brief's own Step 3 `validate_arm()` raises
    # ValidationSpecError whenever maturity != "not_first_look" and `vstop_params`
    # is None -- confirmed by actually running the brief's test verbatim against the
    # brief's own implementation (ValidationSpecError, not the asserted "first_look"
    # result). This is a bug in the brief's test, not a case of synthetic data
    # colliding with real src/ behavior: the gate check runs before any panel/
    # grade_horizons work, so no real indicator computation is in play yet. Fixed by
    # supplying `vstop_params` matching config/rules_literal.yaml's own vstop_flip
    # signal (length=10, mult=2.0, source="close") so the real maturity gate can be
    # exercised without hitting the (separately and correctly tested) "no stop"
    # rejection path. `AAA.NS` is not a real ticker in `literal_env.panels` (confirmed
    # against tests/offline.py's env_literal() universe), so grade_horizons() takes
    # its already-handled "pending" branch (panel is None) rather than erroring.
    # picks are shaped like select_candidates's `entered` output (lowercase
    # entry_price/sl -- see validate_arm's EP/SL normalization, Fix 1).
    picks = [{"ticker": "AAA.NS", "ep": 100.0, "entry_price": 100.0, "sl": 90.0}]
    result = validate_arm(prompt_id=12, env=literal_env, picks=picks,
                           as_of=pd.Timestamp("2026-01-05"), graded_weeks_so_far=13,
                           vstop_params={"length": 10, "mult": 2.0, "source": "close"})
    assert result["maturity"] == "first_look"
    assert len(result["rows"]) > 0
    assert all(row["status"] == "pending" for row in result["rows"])


def test_validate_rejects_a_stop_not_traceable_to_a_vstop_condition():
    import pytest

    from engine.validation import ValidationSpecError
    with pytest.raises(ValidationSpecError):
        validate_arm(prompt_id=12, env=None, picks=[{"ticker": "AAA.NS", "EP": 100.0, "SL": None}],
                     as_of=pd.Timestamp("2026-01-05"), graded_weeks_so_far=13,
                     vstop_params=None)


def test_validate_arm_normalizes_from_entry_price_never_the_screen_time_ep(literal_env):
    """Fix 1: grade_horizons must be graded against `entry_price` (the real
    selection-point fill set by select_candidates), never `ep` (the screen-time weekly
    close draft). Uses a real ticker/date from literal_env.panels, shaped exactly like
    select_candidates's `entered` output, so grade_horizons actually runs its real
    grading branch (not the panel-is-None -> pending shortcut) -- and picks a bar where
    the screen-time close and the next week's real open genuinely differ, so the
    assertion can actually distinguish the two fields."""
    ticker = "20MICRONS.NS"
    panel = literal_env.panels[ticker]
    idx = 149
    as_of = pd.Timestamp(panel.iloc[idx]["date"])
    screen_time_close = float(panel.iloc[idx]["close"])   # the draft `ep` -- must NOT be graded
    next_week_open = float(panel.iloc[idx + 1]["open"])   # the real fill `entry_price`
    assert screen_time_close != pytest.approx(next_week_open), (
        "fixture must pick a bar where ep and entry_price actually differ"
    )

    pick = {
        "ticker": ticker, "name": "20 Microns", "sector": "Chemicals",
        "membership": "full_match", "values": {}, "failed_ids": [],
        "ep": screen_time_close, "sl": screen_time_close * 0.9,
        "r": screen_time_close * 0.1, "entry_price": next_week_open,
    }
    vstop_params = {"length": 10, "mult": 2.0, "source": "close"}
    result = validate_arm(prompt_id=99, env=literal_env, picks=[pick], as_of=as_of,
                           graded_weeks_so_far=13, horizons=[1], vstop_params=vstop_params)

    graded = [row for row in result["rows"] if row["status"] == "graded"]
    assert graded, "expected grade_horizons to actually execute its real grading branch"
    for row in graded:
        assert row["buy_price"] == pytest.approx(next_week_open)
        assert row["buy_price"] != pytest.approx(screen_time_close)


def _declining_weekly_panel() -> pd.DataFrame:
    """A weekly panel whose VStop trend is DOWN at the last bar -- enough bars past the
    length=10 warmup for ATR to be stable, declining the whole way so the trend never
    flips back up (confirmed by directly checking compute_vstop's own `uptrend` column
    below, not assumed)."""
    import numpy as np
    decline = list(np.linspace(130.0, 90.0, 20))
    flat = [90.0] * 5
    return make_panel(decline + flat)


def test_t1_literal_pick_in_weekly_downtrend_is_not_gradable_not_fabricated():
    """Fix 2: a t1_literal pick's EVENT fires on daily bars and can do so while the
    ticker's WEEKLY trend is still down at the same as_of -- the weekly VStop line then
    sits above entry and was never a real resting stop order. Such a pick must be routed
    to its own 'not gradable' status, never through grade_horizons (which would fabricate
    a stop-out loss against that weekly line)."""
    from src.indicators.vstop import compute_vstop

    ticker = "DOWNTREND.NS"
    panel = _declining_weekly_panel()
    vstop_params = {"length": 10, "mult": 2.0, "source": "close"}

    # Confirm the fixture really is in a weekly downtrend at the last bar before relying
    # on it -- not just assumed from how it was constructed.
    vdf = compute_vstop(panel, **vstop_params)
    assert bool(vdf.iloc[-1]["uptrend"]) is False

    as_of = pd.Timestamp(panel.iloc[-1]["date"])
    env = Environment(rule_spec={}, adapter=None, universe_df=pd.DataFrame(),
                       panels={ticker: panel}, shares={}, daily_panels={})
    pick = {"ticker": ticker, "entry_price": 95.0, "sl": 110.0, "ep": 95.0}

    result = validate_arm(prompt_id=7, env=env, picks=[pick], as_of=as_of,
                           graded_weeks_so_far=13, horizons=[1, 2], vstop_params=vstop_params,
                           structure="t1_literal")

    assert len(result["rows"]) == 2
    assert all(row["ticker"] == ticker for row in result["rows"])
    assert all(row["status"] == "not_gradable_weekly_downtrend" for row in result["rows"])
    assert {row["horizon_weeks"] for row in result["rows"]} == {1, 2}
