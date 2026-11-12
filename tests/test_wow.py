"""
Week-over-week arm history study — tests T-01 through T-12
(docs/wow-arm-history-analysis-plan.md §6.4).
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from src.wow.arms import arm_mask, registered_arm_ids
from src.wow.panel import load_replay_panel, build_lane_a_panel, build_lane_b_panel, RETURN_COL


@pytest.fixture(scope="module")
def replay_df():
    return load_replay_panel()


@pytest.fixture(scope="module")
def lane_a_panel(replay_df):
    return build_lane_a_panel(replay_df)


# T-01 -----------------------------------------------------------------------

def test_control_arm_reproduces_244_trade_rows(replay_df, lane_a_panel):
    # Regenerated 2026-09-29 after the RSI(14) seeding fix (src/indicators/rsi.py,
    # docs/forward_test_findings.md's dated entry) and a wider flag-matrix replay
    # window (2024-09-09 -> 2026-09-21, 107 weeks, was 104) -- was 241/104.
    n_trade_rows = int((replay_df["control_status"] == "TRADE").sum())
    assert n_trade_rows == 244

    control = lane_a_panel[lane_a_panel["arm"] == "control"]
    assert control["n_picks"].sum() == 244
    assert control["signal_week"].nunique() == 107  # one row per week, cash weeks included


# T-02 -------------------------------------------------------------------

def test_regression_guard_all_three_estimators(replay_df):
    # Regenerated 2026-09-29, same reason as test_control_arm_reproduces_244_trade_rows
    # above -- was -1.522/-0.634/74/-1.679/-0.918.
    control = replay_df[replay_df["control_status"] == "TRADE"]

    pooled_net = control[RETURN_COL].mean()
    assert pooled_net == pytest.approx(-1.532, abs=0.001)

    pooled_excess = control["fwd_excess_vs_eligible_pct"].mean()
    assert pooled_excess == pytest.approx(-0.636, abs=0.001)

    weekly = control.groupby("signal_week")[RETURN_COL].mean()
    assert len(weekly) == 75
    assert weekly.mean() == pytest.approx(-1.703, abs=0.001)

    weekly_excess = control.groupby("signal_week")["fwd_excess_vs_eligible_pct"].mean()
    assert weekly_excess.mean() == pytest.approx(-0.918, abs=0.001)


# T-03 -------------------------------------------------------------------

def test_thresh_15_row_identical_to_control(lane_a_panel):
    control = lane_a_panel[lane_a_panel["arm"] == "control"].set_index("signal_week")
    thresh15 = lane_a_panel[lane_a_panel["arm"] == "threshold-experiment_15"].set_index("signal_week")
    cols = ["n_picks", "basket_net_pct", "basket_excess_eligible_pp", "hit_rate", "median_pick_net"]
    pd.testing.assert_frame_equal(control[cols], thresh15[cols], check_dtype=False)


# T-04 -------------------------------------------------------------------

def test_zero_pick_weeks_are_null_not_zero(lane_a_panel):
    # Regenerated 2026-09-29, same reason as test_control_arm_reproduces_244_trade_rows
    # above -- was 104 - 74.
    control = lane_a_panel[lane_a_panel["arm"] == "control"]
    cash_weeks = control[control["n_picks"] == 0]
    assert len(cash_weeks) == 107 - 75
    assert cash_weeks["basket_net_pct"].isna().all()
    assert not (cash_weeks["basket_net_pct"] == 0.0).any()

    from src.wow.stats import equity_curve
    curve = equity_curve(control.sort_values("signal_week").set_index("signal_week")["basket_net_pct"])
    # a null week must compound at 1.0 (multiplicatively neutral), not drop out of the index
    assert len(curve) == 107  # was 104, see the 2026-09-29 note above


# T-05 -------------------------------------------------------------------

def test_cross_lane_difference_raises(lane_a_panel):
    lane_b = build_lane_b_panel()
    combined = pd.concat([lane_a_panel.assign(lane="A"), lane_b], ignore_index=True)

    def compute_cross_lane_diff(panel: pd.DataFrame, arm_a: str, arm_b: str):
        row_a = panel[panel["arm"] == arm_a]
        row_b = panel[panel["arm"] == arm_b]
        lanes = set(row_a["lane"]).union(row_b["lane"])
        if len(lanes) > 1 and {"A", "B"}.issubset(lanes):
            raise ValueError("cross-lane difference: Lane A and Lane B rows may not be compared")
        return row_a["basket_net_pct"].mean() - row_b["basket_net_pct"].mean()

    with pytest.raises(ValueError, match="cross-lane"):
        compute_cross_lane_diff(combined, "control", "V2_N2")


# T-06 -------------------------------------------------------------------

def test_unregistered_arm_id_raises():
    df = pd.DataFrame({"control_status": ["TRADE"], "A01_vstop_flip_up": [1]})
    with pytest.raises(ValueError):
        arm_mask(df, "made_up_arm_nobody_registered")

    assert "made_up_arm_nobody_registered" not in registered_arm_ids()
    with pytest.raises(ValueError, match="T-06|not in registry"):
        build_lane_a_panel(load_replay_panel(), arm_ids=["made_up_arm_nobody_registered"])


# T-07 -------------------------------------------------------------------

def test_verify_byte_identical(tmp_path):
    from tests.track_wow import build, verify

    build(tmp_path)
    # verify() always compares against results/wow/ — exercise the identical logic here
    # against our own tmp build, rebuilt a second time into a sibling dir.
    tmp_path_2 = tmp_path / "second"
    build(tmp_path_2)
    import filecmp
    assert filecmp.cmp(tmp_path / "arm_week_panel.csv", tmp_path_2 / "arm_week_panel.csv", shallow=False)


# T-08 -------------------------------------------------------------------

def test_below_floor_statistics_suppressed():
    from src.wow import stats

    short_series = np.array([1.0, 2.0, -1.0, 0.5])  # far below MIN_TREND_WEEKS=26
    n = len(short_series)
    assert n < stats.MIN_TREND_WEEKS
    msg = stats.suppress(n, stats.MIN_TREND_WEEKS)
    assert msg == f"insufficient history (n={n}, floor={stats.MIN_TREND_WEEKS})"
    assert "insufficient history" in msg
    # the message is prose, not a bare number standing in for the suppressed statistic
    assert not msg.strip().replace(".", "").replace("-", "").isdigit()


# T-09 -------------------------------------------------------------------

def test_lane_c_append_one_row_per_week_no_mutation(tmp_path, monkeypatch):
    import json
    import shutil
    from src.wow import panel as panel_mod

    fwd_dir = tmp_path / "forward_test"
    fwd_dir.mkdir()
    real_fwd = panel_mod.ROOT / "results" / "forward_test"
    for f in real_fwd.glob("picks_*.json"):
        shutil.copy(f, fwd_dir / f.name)

    monkeypatch.setattr(panel_mod, "ROOT", tmp_path)
    (tmp_path / "results").mkdir(exist_ok=True)
    shutil.copytree(fwd_dir, tmp_path / "results" / "forward_test", dirs_exist_ok=True)

    before = panel_mod.build_lane_c_panel()
    n_before = len(before)

    # simulate one new graded forward week appended -- a synthetic far-future date, so
    # this never collides with whatever real signal weeks happen to be on disk (e.g.
    # 2026-09-14 was reconstructed for real in results/forward_test/ on 2026-09-27,
    # which used to silently overwrite this test's fixed "new" filename instead of
    # adding one, masking the append it means to test).
    new_week = "2099-01-04"
    new_rec = {
        "signal_week_start": new_week,
        "graded": {"detail": [{"ticker": "NEWPICK.NS", "status": "TRADE", "ret_pct_net": 1.23,
                                "exit_reason": "week_close"}]},
    }
    (tmp_path / "results" / "forward_test" / f"picks_{new_week}.json").write_text(json.dumps(new_rec))

    after = panel_mod.build_lane_c_panel()
    control_live_before = before[before["arm"] == "control_live"]
    control_live_after = after[after["arm"] == "control_live"]

    assert len(control_live_after) == len(control_live_before) + 1
    # no existing row's values changed
    common_weeks = set(control_live_before["signal_week"]) & set(control_live_after["signal_week"])
    for wk in common_weeks:
        before_row = control_live_before[control_live_before["signal_week"] == wk].iloc[0]
        after_row = control_live_after[control_live_after["signal_week"] == wk].iloc[0]
        assert before_row["basket_net_pct"] == after_row["basket_net_pct"] or (
            pd.isna(before_row["basket_net_pct"]) and pd.isna(after_row["basket_net_pct"]))


# T-10, T-11 ---------------------------------------------------------------

def test_index_bar_matches_holding_week_open_close(replay_df):
    from src.wow.three_line import build_weekly_three_line, _index_week_return
    from src.flags.grade import _next_week_bar

    wk = replay_df["signal_week"].iloc[0]
    as_of = pd.Timestamp(wk)
    wk_df = replay_df[replay_df["signal_week"] == wk]

    # midcap reconstruction must equal fwd_excess_vs_benchmark_pct's own bench (T-11)
    bench_from_excess = (wk_df[RETURN_COL] - wk_df["fwd_excess_vs_benchmark_pct"]).dropna()
    assert bench_from_excess.std() < 0.01  # constant within the week (float noise only)

    # synth a tiny nifty50 panel: two bars, next-week bar must be the one selected
    signal_bar = {"date": as_of, "open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0}
    holding_bar = {"date": as_of + pd.Timedelta(weeks=1), "open": 200.0, "high": 210.0, "low": 195.0, "close": 220.0}
    nifty_panel = pd.DataFrame([signal_bar, holding_bar])
    ret, missing = _index_week_return(nifty_panel, as_of)
    assert not missing
    assert ret == pytest.approx((220.0 - 200.0) / 200.0 * 100, abs=1e-6)  # holding week open->close
    assert ret != pytest.approx((100.0 - 220.0) / 220.0 * 100, abs=1e-6)  # not the signal week, not close-to-close

    # cross-check against the actual pipeline's own next-week-bar selection
    bar = _next_week_bar(nifty_panel, as_of)
    assert bar["date"] == holding_bar["date"]


def test_vs_midcap150_reconstructed_matches_control_excess(replay_df):
    from src.wow.three_line import build_weekly_three_line

    nifty50_panel = pd.DataFrame({
        "date": pd.to_datetime(sorted(replay_df["signal_week"].unique())),
    })
    nifty50_panel["open"] = 100.0
    nifty50_panel["close"] = 100.0  # flat NIFTY50 -> isolates the midcap reconstruction check
    nifty50_panel["high"] = 100.0
    nifty50_panel["low"] = 100.0

    three_line = build_weekly_three_line(replay_df, nifty50_panel)
    control = replay_df[replay_df["control_status"] == "TRADE"]
    control_excess = control.groupby("signal_week")["fwd_excess_vs_benchmark_pct"].mean()
    control_basket = control.groupby("signal_week")[RETURN_COL].mean()
    implied_midcap = (control_basket - control_excess).round(4)

    joined = three_line.set_index("signal_week")[["niftymidcap150_wk_pct"]].join(
        implied_midcap.rename("implied"), how="inner")
    diff = (joined["niftymidcap150_wk_pct"] - joined["implied"]).abs()
    assert (diff <= 0.01).all()


# T-12 -------------------------------------------------------------------

# Lane C T1-vs-Control paired comparison ------------------------------------

def test_lane_c_t1_vs_control_suppressed_below_floor():
    """Real state today: 1 graded Lane C week — the T1-vs-Control paired comparison
    must report the suppression string (§5.4), not a number, and grow to a real
    figure once enough weeks accumulate (simulated here with synthetic weeks)."""
    from src.wow.summarise import paired_vs_control
    from src.wow import stats

    real_panel = pd.read_csv(panel_csv_path())
    real = paired_vs_control(real_panel, "C", control_arm="control_live", mode="forward")
    net_row = real[real["basis"] == "net_pct"].iloc[0]
    assert net_row["n_paired_weeks"] < stats.MIN_PAIRED_WEEKS
    assert net_row["status"] == stats.suppress(int(net_row["n_paired_weeks"]), stats.MIN_PAIRED_WEEKS)
    assert pd.isna(net_row["mean_diff"])

    # simulate enough weeks to clear the floor
    weeks = [f"2030-01-{i:02d}" for i in range(1, 15)]
    synth = pd.DataFrame({
        "lane": ["C"] * 28,
        "arm": (["control_live"] * 14) + (["t1_shadow"] * 14),
        "signal_week": weeks + weeks,
        "n_picks": [2] * 28,
        "basket_net_pct": [1.0] * 14 + [1.5] * 14,  # t1_shadow consistently +0.5pp above control_live
        "basket_excess_eligible_pp": [np.nan] * 28,
        "basket_excess_bench_pp": [np.nan] * 28,
        "recording_mode": ["forward"] * 28,
    })
    synth_result = paired_vs_control(synth, "C", control_arm="control_live", mode="forward")
    synth_net = synth_result[synth_result["basis"] == "net_pct"].iloc[0]
    assert synth_net["n_paired_weeks"] == 14
    assert synth_net["status"] == "ok"
    assert synth_net["mean_diff"] == pytest.approx(0.5, abs=1e-6)


def panel_csv_path():
    from pathlib import Path
    return Path(__file__).resolve().parents[1] / "results" / "wow" / "arm_week_panel.csv"


def test_nifty50_never_enters_arm_filter_or_gate():
    import ast
    import pathlib

    src_flags = pathlib.Path(__file__).resolve().parents[1] / "src" / "flags"
    arms_file = pathlib.Path(__file__).resolve().parents[1] / "src" / "wow" / "arms.py"

    for path in list(src_flags.glob("*.py")) + [arms_file]:
        text = path.read_text()
        assert "^NSEI" not in text, f"^NSEI referenced in {path} — must be a reporting series only"
        assert "NIFTY50" not in text.upper(), f"NIFTY50 referenced in {path} — must be a reporting series only"


# T1 historical replay ---------------------------------------------------------
# docs/wow-arm-history-analysis-plan.md follow-up: give T1 the same multi-week
# replay treatment Control's flag-matrix already has (src/screen/t1_scan.py,
# tests/track_forward.py:t1_replay(), src/wow/panel.py's Lane C recording_mode split).

# T-13 -------------------------------------------------------------------

def test_t1_scan_no_future_leakage():
    """scan_t1_week() must never pull a daily bar dated after as_of into its 5-day
    window — the exact leak the original record_t1_shadow() had for any as_of other
    than 'today' (days = all_dates(daily_panels)[-5:], unconditional on as_of)."""
    from tests.offline import make_daily_panel, make_panel
    from src.screen.t1_scan import scan_t1_week
    from src.config import load_rule_spec
    from pathlib import Path

    rule_spec = load_rule_spec(str(Path(__file__).resolve().parents[1] / "config" / "rules.yaml"))

    tickers = ["LEAK.NS"]
    # Daily panel extends WELL PAST as_of -- if the fix regresses, the scan would pick
    # up days from beyond as_of instead of stopping there.
    daily = make_daily_panel(np.linspace(500, 700, 120), start="2023-01-02")
    weekly = make_panel(np.full(60, 500.0), start="2022-01-03")  # W-MON, as_of mid-history

    uni = pd.DataFrame([{"ticker": t, "name": t, "sector": "Test", "isin": "X"} for t in tickers])
    shares = {t: 3e8 for t in tickers}
    daily_panels = {t: daily for t in tickers}
    weekly_panels = {t: weekly for t in tickers}

    class _FakeAdapter:
        def benchmark_series(self, ticker, history_weeks):
            return pd.DataFrame()

        def daily_benchmark_series(self, ticker, history_days):
            return pd.DataFrame()

    # as_of is a Monday well before the daily panel's own last date (2023-01-02 + 120
    # business days, ~2023-06-16) -- forces the fix to actually trim something, not
    # pass vacuously. The window must be as_of's OWN week (as_of .. as_of+6), never a
    # later week's bars, even though those are also present in the daily panel.
    as_of = pd.Timestamp("2023-01-30")  # Monday, 4 weeks after the daily panel's start
    rec = scan_t1_week(as_of, rule_spec, _FakeAdapter(), uni, weekly_panels, daily_panels, shares,
                        recording_mode="replay")
    assert rec is not None
    window_days = [pd.Timestamp(d) for d in rec["window_days"]]
    week_end = as_of + pd.Timedelta(days=6)
    assert all(as_of <= d <= week_end for d in window_days), (
        f"window {window_days} leaks outside as_of's own week [{as_of}, {week_end}]")


# T-14 -------------------------------------------------------------------

def test_t1_replay_deterministic_on_rerun(tmp_path, monkeypatch):
    """Two t1_replay() runs over the same small range produce byte-identical graded
    ledgers (mirrors T-07's determinism check for the Lane A panel builder)."""
    import shutil
    import tests.track_forward as tf

    out_dir_a = tmp_path / "a"
    out_dir_b = tmp_path / "b"
    for out_dir in (out_dir_a, out_dir_b):
        monkeypatch.setattr(tf, "OUT", out_dir)
        tf.t1_replay("2024-09-09", "2024-09-23")

    ledger_a = out_dir_a / "replay" / "t1_ledger_grades.csv"
    ledger_b = out_dir_b / "replay" / "t1_ledger_grades.csv"
    assert ledger_a.exists() and ledger_b.exists()

    a = pd.read_csv(ledger_a).drop(columns=["graded_utc"], errors="ignore")
    b = pd.read_csv(ledger_b).drop(columns=["graded_utc"], errors="ignore")
    pd.testing.assert_frame_equal(a, b)


# T-15 -------------------------------------------------------------------

def test_t1_replay_row_counts_match_historical_expectation(monkeypatch):
    """scan_t1_week() run for a fixed historical as_of reproduces the same
    n_extra_confirmed/n_extra_reversed set logic test_t1_shadow.py already validates
    for the live path — same synthetic panels, called through the as_of-parameterized
    entry point instead of the 'now'-pinned live wrapper."""
    from tests.offline import make_daily_panel, make_panel
    from src.screen.t1_scan import scan_t1_week
    import src.screen.t1_scan as t1_scan_mod
    import src.screen.engine as engine_mod
    from src.config import load_rule_spec
    from pathlib import Path

    monkeypatch.setattr(engine_mod, "evaluate_predicate",
                         lambda predicate, locals_: bool(locals_.get("flip_up")) if "flip_up" in predicate else True)
    monkeypatch.setattr(t1_scan_mod, "_rsi_band_bounds", lambda rule_spec: (0.0, 100.0))

    rule_spec = load_rule_spec(str(Path(__file__).resolve().parents[1] / "config" / "rules.yaml"))
    tickers = ["HOLD.NS"]
    down = np.linspace(600, 500, 40)
    ramp = np.linspace(500, 560, 5)
    daily = make_daily_panel(np.concatenate([down, ramp]), start="2023-01-02")
    # as_of must land on the same week as daily's own last 5 trading days
    # (2023-02-27 Mon - 2023-03-03 Fri) -- see tests/test_t1_shadow.py's identical fix.
    weekly = make_panel(np.full(40, 500.0), start="2022-05-30")

    uni = pd.DataFrame([{"ticker": t, "name": t, "sector": "Test", "isin": "X"} for t in tickers])
    shares = {t: 3e8 for t in tickers}
    daily_panels = {t: daily for t in tickers}
    weekly_panels = {t: weekly for t in tickers}

    class _FakeAdapter:
        def benchmark_series(self, ticker, history_weeks):
            return pd.DataFrame()

        def daily_benchmark_series(self, ticker, history_days):
            return pd.DataFrame()

    as_of = pd.Timestamp(weekly["date"].iloc[-1])
    rec = scan_t1_week(as_of, rule_spec, _FakeAdapter(), uni, weekly_panels, daily_panels, shares,
                        recording_mode="replay")
    assert rec is not None
    assert rec["n_extra_confirmed"] == 1
    assert rec["picks"][0]["ticker"] == "HOLD.NS"
    assert rec["n_extra_reversed"] == 0
    assert rec["recording_mode"] == "replay"


# T-16 -------------------------------------------------------------------

def test_lane_c_separates_replay_and_forward_mode():
    """trend_tests()/paired_vs_control() must never mix a Lane C arm's 'replay' and
    'forward' recording_mode rows into one series, and the forward-only,
    graduation-track paired comparison must exclude replay rows entirely."""
    from src.wow.summarise import trend_tests, paired_vs_control

    weeks_replay = [f"2024-{m:02d}-01" for m in range(1, 13)] + [f"2024-{m:02d}-08" for m in range(1, 15)]
    n_replay = len(weeks_replay)  # 26 -- clears MIN_TREND_WEEKS
    weeks_forward = ["2026-09-07"]

    rows = []
    for wk in weeks_replay:
        rows.append({"lane": "C", "arm": "t1_shadow", "signal_week": wk, "n_picks": 3,
                     "basket_net_pct": 1.0, "basket_excess_eligible_pp": np.nan,
                     "basket_excess_bench_pp": np.nan, "recording_mode": "replay"})
        rows.append({"lane": "C", "arm": "control_live", "signal_week": wk, "n_picks": 1,
                     "basket_net_pct": 0.5, "basket_excess_eligible_pp": np.nan,
                     "basket_excess_bench_pp": np.nan, "recording_mode": "replay"})
    for wk in weeks_forward:
        rows.append({"lane": "C", "arm": "t1_shadow", "signal_week": wk, "n_picks": 2,
                     "basket_net_pct": -99.0, "basket_excess_eligible_pp": np.nan,
                     "basket_excess_bench_pp": np.nan, "recording_mode": "forward"})
        rows.append({"lane": "C", "arm": "control_live", "signal_week": wk, "n_picks": 2,
                     "basket_net_pct": 4.35, "basket_excess_eligible_pp": np.nan,
                     "basket_excess_bench_pp": np.nan, "recording_mode": "forward"})
    panel = pd.DataFrame(rows)

    t_replay = trend_tests(panel, "C", mode="replay")
    t1_row = t_replay[(t_replay["arm"] == "t1_shadow") & (t_replay["basis"] == "net_pct")].iloc[0]
    assert t1_row["n_weeks_with_picks"] == n_replay
    assert t1_row["status"] == "ok"  # clears the 26-week floor, no forward row mixed in

    t_forward = trend_tests(panel, "C", mode="forward")
    t1_row_fwd = t_forward[(t_forward["arm"] == "t1_shadow") & (t_forward["basis"] == "net_pct")].iloc[0]
    assert t1_row_fwd["n_weeks_with_picks"] == 1  # only the 1 forward week, none of the 26 replay weeks

    paired_fwd = paired_vs_control(panel, "C", control_arm="control_live", mode="forward")
    p_row = paired_fwd[paired_fwd["arm"] == "t1_shadow"].iloc[0]
    assert p_row["n_paired_weeks"] == 1  # forward-only pairing excludes the 26 replay weeks entirely


# T-17 -------------------------------------------------------------------

def test_t1_filtered_score_regression_guard():
    """Pinned-numbers check: the score>=40 filter recomputed from the live 2026-09-07
    T1 record's own score_filter_eligible column must reproduce the SAME
    filtered_basket_net_pct the record's own `graded` block already stored — and the
    same number build_lane_c_panel()'s new t1_shadow_filtered (forward mode) row for
    that week must show."""
    import json
    from pathlib import Path

    path = Path(__file__).resolve().parents[1] / "results" / "forward_test" / "picks_2026-09-07_t1.json"
    rec = json.loads(path.read_text())
    graded = rec["graded"]
    detail = pd.DataFrame(graded["detail"])

    filtered = detail[detail["score_filter_eligible"] == True]  # noqa: E712
    recomputed_mean = round(float(filtered["ret_pct_net"].mean()), 3)
    assert recomputed_mean == pytest.approx(graded["filtered_basket_net_pct"], abs=0.001)
    assert len(filtered) == graded["n_filtered_eligible"]

    from src.wow.panel import build_lane_c_panel
    panel = build_lane_c_panel()
    row = panel[(panel["arm"] == "t1_shadow_filtered") & (panel["signal_week"] == "2026-09-07")
                & (panel["recording_mode"] == "forward")]
    assert len(row) == 1
    assert row.iloc[0]["basket_net_pct"] == pytest.approx(graded["filtered_basket_net_pct"], abs=0.001)
