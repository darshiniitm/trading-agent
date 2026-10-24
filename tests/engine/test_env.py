from engine.env import load_environment


def test_offline_literal_environment_loads_universe_and_panels():
    env = load_environment("literal", offline=True)
    assert len(env.universe_df) > 0
    assert len(env.panels) > 0
    assert env.shares  # non-empty dict


def test_environment_is_cached():
    env1 = load_environment("literal", offline=True)
    env2 = load_environment("literal", offline=True)
    assert env1 is env2


def test_last_bar_date_is_the_last_week_that_has_a_close():
    # a week still in progress has bars (open/volume) but no close; it is not a date a screen can run on
    import pandas as pd
    from types import SimpleNamespace
    from engine.env import last_bar_date
    w = pd.DataFrame({"date": pd.to_datetime(["2026-09-21", "2026-09-28", "2026-10-05"]), "close": [1.0, 2.0, float("nan")]})
    assert last_bar_date(SimpleNamespace(panels={"A.NS": w, "B.NS": w})) == "2026-09-28"
    # a few stragglers with a close on the in-progress week do not make it a runnable date
    odd = w.copy(); odd.loc[2, "close"] = 3.0
    assert last_bar_date(SimpleNamespace(panels={"A.NS": w, "B.NS": w, "C.NS": w, "D.NS": odd})) == "2026-09-28"
    assert last_bar_date(SimpleNamespace(panels={"A.NS": odd, "B.NS": odd, "C.NS": w})) == "2026-10-05"
    assert last_bar_date(SimpleNamespace(panels={})) is None
