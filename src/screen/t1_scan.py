"""
T1's daily rolling-window scan, factored out of tests/track_forward.py:record_t1_shadow()
so it can run for ANY historical as_of, not just "now" (docs/wow-arm-history-analysis-plan.md
follow-up: give T1 the same multi-week replay treatment Control's flag-matrix already has).

record_t1_shadow() is now a thin wrapper around scan_t1_week(as_of=latest, recording_mode="forward").
tests/track_forward.py:t1_replay() calls scan_t1_week() once per historical week
(recording_mode="replay") to build results/forward_test/replay/.

The one behavioral fix versus the original inline code: `days` used to be computed as
`all_dates(daily_panels)[-5:]` — the last 5 dates of the WHOLE daily cache, not the last 5
dates as of a given historical Friday. For any as_of other than the latest date that leaked
future daily bars into the scan. Fixed here by filtering to `d <= as_of` first.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pandas as pd

from src.screen.candidate_score import score_row
from src.screen.daily_scale import daily_rule_spec
from src.screen.engine import run_screen, compute_features_for_ticker, _slice_as_of
from src.trade.builder import _rsi_band_bounds

# Shadow-only score filter for T1 (docs/forward-test-response-and-volume-plan.md §3.8).
# NOT a graduation to real capital -- §3.5/§4 require a bootstrap CI beating Control
# before any Test arm touches real capital, and T1 is nowhere near that review point
# (1 graded week). This just carves out a second shadow sub-basket (T1 names scoring
# >=40) so the eventual rank-IC/graduation decision has evidence on whether
# thresholding the (still-unvalidated) score actually helps, instead of guessing.
T1_SCORE_FILTER_THRESHOLD = 40.0


def _all_dates(panels: dict[str, pd.DataFrame]) -> list[pd.Timestamp]:
    return sorted({pd.Timestamp(d) for p in panels.values() for d in p["date"]})


def scan_t1_week(as_of: pd.Timestamp, rule_spec: dict, adapter, universe_df: pd.DataFrame,
                  panels: dict[str, pd.DataFrame], daily_panels: dict[str, pd.DataFrame],
                  shares: dict[str, float], recording_mode: str = "forward",
                  score_filter_threshold: float = T1_SCORE_FILTER_THRESHOLD) -> dict | None:
    """T1 (docs/forward-test-response-and-volume-plan.md §3.2): scan the last 5 trading
    days up to and including as_of's own Friday bar with the identical VStop+RSI rule
    instead of only Friday's close, and see if it catches genuine flips the weekly anchor
    misses. Shadow only -- no capital, no change to Control's own record().

    `panels`/`daily_panels` must already be loaded by the caller (loop callers load the
    daily parquet ONCE outside any per-week loop, not per as_of -- see t1_replay()).
    Returns None if there isn't enough daily history up to as_of for a 5-day window.
    """
    as_of = pd.Timestamp(as_of)
    control_res = run_screen(as_of, rule_spec, adapter, universe_df, panels, shares)
    control_tickers = set(control_res["survivors"]["ticker"]) if not control_res["survivors"].empty else set()

    if not daily_panels:
        return None

    # PIT fix: `as_of` is the signal week's own Monday (weekly bars are Monday-dated,
    # e.g. "2024-09-09"), not its Friday -- the window must be THAT week's own trading
    # days (Monday through the following Sunday), not "the daily cache's last 5 dates
    # up to and including as_of", which is wrong on both ends: for a historical as_of it
    # excludes the week's own Tue-Fri bars entirely (they're dated AFTER the Monday), and
    # for the live path it can silently pull in a day or two from the following week if
    # the daily cache has been fetched further ahead than the weekly panel. Bounding the
    # window to [as_of, as_of + 6 days] is correct for both replay and live.
    days = [d for d in _all_dates(daily_panels) if as_of <= d <= as_of + pd.Timedelta(days=6)]
    if len(days) < 2:
        return None
    friday = days[-1]

    spec = daily_rule_spec(rule_spec)
    history_days = rule_spec["data"]["history_weeks"] * 7

    def bench_fetch(ticker, _n):
        return adapter.daily_benchmark_series(ticker, history_days)

    per_day_survivors = {}
    for d in days:
        res_d = run_screen(d, spec, adapter, universe_df, daily_panels, shares, benchmark_fetch=bench_fetch)
        per_day_survivors[d] = res_d["survivors"]

    # A flip is a one-bar event (flip_up is only True on the transition bar), so a
    # ticker that flipped on, say, Tuesday will correctly show flip_up=False again
    # on Friday even though it never reversed. "Still valid at Friday" therefore
    # checks continued daily uptrend (the VStop line hasn't flipped back down),
    # not a second flip_up event -- that's what "reversed by Friday" actually means.
    midweek_tickers = set()
    for d in days:
        df = per_day_survivors[d]
        if not df.empty:
            midweek_tickers |= set(df["ticker"])
    extra_candidates = sorted(midweek_tickers - control_tickers)

    rsi_lo, rsi_hi = _rsi_band_bounds(rule_spec)

    def _still_valid(feats):
        if feats is None or not feats["uptrend"]:
            return False
        rsi = feats.get("rsi")
        return rsi is not None and rsi_lo <= rsi <= rsi_hi

    friday_feats = {}
    for tk in extra_candidates:
        panel = _slice_as_of(daily_panels[tk], friday)
        friday_feats[tk] = compute_features_for_ticker(panel, spec)

    # "Still valid at Friday" means the ticker would satisfy BOTH predicates if
    # Control's own weekly funnel were run against it right now: still trending
    # (VStop hasn't flipped down) AND still inside the RSI sweet-spot band --
    # not just trend continuation, or a flip whose RSI already ran past 65
    # would get counted as a live signal when Control's own rule would reject it.
    extra_confirmed = [tk for tk in extra_candidates if _still_valid(friday_feats[tk])]
    extra_reversed = [tk for tk in extra_candidates if tk not in extra_confirmed]

    CR = 1e7
    liq_lookback = spec["universe"]["liquidity"]["lookback_weeks"]
    uni_by_ticker = universe_df.set_index("ticker")
    rsi_band = (rsi_lo, rsi_hi)
    primary_lb = rule_spec["sector"]["rs_lookbacks_weeks"][0]
    rs_col = f"rs_{primary_lb}w"
    sec_rs = control_res["sector_rs"]  # Friday-anchored, computed once above; same table Control's own picks use.

    picks = []
    for tk in extra_confirmed:
        feats = friday_feats[tk]
        R = float(feats["close"]) - float(feats["vstop_line"])
        panel = _slice_as_of(daily_panels[tk], friday)
        turnover_cr = (panel["close"] * panel["volume"]).tail(liq_lookback) / CR
        sh = shares.get(tk)
        row = uni_by_ticker.loc[tk] if tk in uni_by_ticker.index else {}
        sector = row.get("sector") if hasattr(row, "get") else None
        pick = {
            "ticker": tk,
            "name": row.get("name") if hasattr(row, "get") else None,
            "sector": sector,
            "status": "T1_EXTRA_vs_control",
            "signal_close": round(float(feats["close"]), 4),
            "vstop_line_SL": round(float(feats["vstop_line"]), 4),
            "rsi": round(float(feats["rsi"]), 3) if feats["rsi"] is not None else None,
            "atr": round(float(feats["atr"]), 4) if feats.get("atr") is not None else None,
            "volume": float(feats["volume"]) if feats.get("volume") is not None else None,
            "avg_vol_8w": float(feats["avg_vol_8w"]) if feats.get("avg_vol_8w") is not None else None,
            "mktcap_cr": round(float(feats["close"]) * sh / CR, 1) if sh else None,
            "turnover_cr": round(float(turnover_cr.median()), 2) if len(turnover_cr) else None,
            "R_ref": round(R, 4),
            "R_pct_of_close": round(R / float(feats["close"]) * 100, 3),
        }
        rs_val = None
        if sector is not None and not sec_rs.empty and sector in set(sec_rs["sector"]) and rs_col in sec_rs.columns:
            match = sec_rs[sec_rs["sector"] == sector]
            if not match.empty:
                rs_val = match.iloc[0][rs_col]
        pick.update(score_row(pick, rule_spec, rsi_band, rs_val))
        pick["score_filter_eligible"] = bool(pick.get("candidate_score") is not None
                                              and pick["candidate_score"] >= score_filter_threshold)
        picks.append(pick)

    filtered_tickers = [p["ticker"] for p in picks if p.get("score_filter_eligible")]

    return {
        "record_id": f"fwd_{as_of.date()}_t1",
        "created_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "signal_week_start": str(as_of.date()),
        "window_days": [str(d.date()) for d in days],
        "control_survivors": sorted(control_tickers),
        "note": ("extra_confirmed = names T1's mid-week scan caught that Control's Friday-only "
                 "anchor missed, and which were STILL valid signals at Friday's close (these are "
                 "the shadow picks below). extra_reversed = the same catch, but the signal had "
                 "already reversed by Friday -- would never have been a trade Control could take, "
                 "per §3.4's 'reversed by Friday anyway' tracking requirement."),
        "n_extra_confirmed": len(extra_confirmed),
        "n_extra_reversed": len(extra_reversed),
        "extra_reversed_tickers": extra_reversed,
        "picks": picks,
        "score_filter_note": ("SHADOW ONLY -- not a graduation to real capital. §3.5/§4 require a "
                               "bootstrap CI beating Control before any Test arm touches real money; "
                               "T1 is nowhere near that review point. This threshold carves out a "
                               "second shadow sub-basket to accumulate evidence on whether the "
                               "(still-unvalidated) §3.8 score helps, per open decision #9."),
        "score_filter_threshold": score_filter_threshold,
        "n_filtered_eligible": len(filtered_tickers),
        "filtered_tickers": filtered_tickers,
        "recording_mode": recording_mode,
        "graded": None,
    }
