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
