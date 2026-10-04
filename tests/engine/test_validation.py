import pandas as pd

from engine.validation import validate_arm


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
    picks = [{"ticker": "AAA.NS", "EP": 100.0, "SL": 90.0}]
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
