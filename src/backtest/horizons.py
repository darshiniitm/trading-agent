"""
Step 5 extended — 1-, 2- and 3-week horizon grading (docs/literal-spec-plan.md's "Step 5
extended: 1-, 2- and 3-week returns" section, added 27 Sep 2026; registered
docs/forward-test-response-and-volume-plan.md §3.11).

Each Literal pick is bought once, at its recorded EP (the signal Friday's own close,
decided 26 Sep 2026), and measured at every configured horizon (config/rules_literal.yaml's
`validation.horizons_weeks`) in two parallel views:

  signal — close-to-close, stop ignored: does the flip lead to a move over 1-3 weeks?
  trade  — the position is exited at SL if the stop is hit (or at the open if it gaps
           below SL), and that exit result carries forward unchanged to every later
           horizon. The stop TRAILS week-by-week (Dharmin's decision, 27 Sep 2026): week
           1 uses the entry VStop line (the pick's own recorded SL); week 2 onward uses
           the PRIOR week's own closed VStop line, exactly the mechanism
           src/backtest/harness.py:simulate_trend_hold already uses for D3 ("the stop
           that can actually be resting in the market during week i is the level known
           at the close of week i-1"). This module does not fork that mechanism, but it
           cannot reuse it as-is either: simulate_trend_hold's EP is the FOLLOWING
           week's open (Control's convention) and it also exits on a trend flip-down,
           neither of which applies to Literal's EP-is-signal-close convention or to
           this fixed-horizon feature (no early exit on trend reversal -- only a stop
           counts). grade_horizons() is the same walk, adapted to those two differences.

Every week's open/low/close is read through corrected_week_bar() (src/data/holding_week.py,
D7 fix), for both views -- a look-ahead-safe single source of truth for what actually
happened that week, live or in replay (HARNESS §3: no separate backtest-only bar reader).

A horizon that hasn't happened yet in the data available is "pending", never guessed.
"""
from __future__ import annotations

from collections import defaultdict

import pandas as pd

from src.data.holding_week import corrected_week_bar
from src.indicators.vstop import compute_vstop


def _vstop_params(rule_spec: dict) -> dict:
    return next(s["params"] for s in rule_spec["signals"] if s["id"] == "vstop_flip")


def _pending_row(ticker: str, as_of: pd.Timestamp, horizon: int, view: str, ep: float | None) -> dict:
    return {
        "ticker": ticker, "signal_week_start": str(pd.Timestamp(as_of).date()),
        "horizon_weeks": horizon, "view": view, "status": "pending",
        "buy_price": ep, "r_Nw": None, "step_ret": None,
        "bench_Nw": None, "excess_Nw": None, "mdd_to_Nw": None,
        "exit_reason": None, "sl_hit_week": None, "sl_level_used": None, "stop_path": None,
    }


def _graded_row(ticker: str, as_of: pd.Timestamp, horizon: int, view: str, ep: float,
                 r_Nw: float, bench_Nw: float | None, mdd_to_Nw: float,
                 exit_reason: str | None = None, sl_hit_week: str | None = None,
                 sl_level_used: float | None = None, stop_path: list | None = None) -> dict:
    excess = round(r_Nw - bench_Nw, 4) if bench_Nw is not None else None
    row = {
        "ticker": ticker, "signal_week_start": str(pd.Timestamp(as_of).date()),
        "horizon_weeks": horizon, "view": view, "status": "graded",
        "buy_price": ep, "r_Nw": r_Nw, "step_ret": None,
        "bench_Nw": bench_Nw, "excess_Nw": excess, "mdd_to_Nw": round(mdd_to_Nw, 4),
        "exit_reason": None, "sl_hit_week": None, "sl_level_used": None, "stop_path": None,
    }
    if view == "trade":
        row.update(exit_reason=exit_reason, sl_hit_week=sl_hit_week,
                    sl_level_used=sl_level_used, stop_path=stop_path)
    return row


def _bench_return_at(bench: pd.DataFrame | None, bench_close_at_signal: float | None,
                      week_date: pd.Timestamp) -> float | None:
    if bench is None or bench.empty or bench_close_at_signal is None:
        return None
    bb = bench[bench["date"] <= week_date]
    if bb.empty:
        return None
    return round((float(bb["close"].iloc[-1]) - bench_close_at_signal) / bench_close_at_signal * 100, 4)


def _grade_one_pick(pick: dict, panel: pd.DataFrame, as_of: pd.Timestamp, horizons: list[int],
                     bench: pd.DataFrame | None, bench_close_at_signal: float | None,
                     vstop_params: dict, daily_panels: dict) -> list[dict]:
    ticker = pick["ticker"]
    EP = float(pick["EP"])
    entry_SL = float(pick["SL"])

    vdf = compute_vstop(panel, length=vstop_params["length"], mult=vstop_params["mult"],
                         source=vstop_params["source"]).reset_index(drop=True)
    matches = vdf.index[vdf["date"] == pd.Timestamp(as_of)]
    if len(matches) == 0:
        return [_pending_row(ticker, as_of, h, v, EP) for h in horizons for v in ("signal", "trade")]
    entry_idx = matches[0]
    max_h = max(horizons)
    horizon_set = set(horizons)

    rows: list[dict] = []
    exit_reason = exit_price = exit_week_date = sl_level_at_exit = None
    stop_path: list[dict] = []
    signal_mdd = 0.0
    trade_mdd = 0.0

    for step in range(1, max_h + 1):
        idx = entry_idx + step
        if idx >= len(vdf):
            rows.extend(_pending_row(ticker, as_of, h, v, EP)
                        for h in horizons if h >= step for v in ("signal", "trade"))
            break

        week = vdf.loc[idx]
        week_date = pd.Timestamp(week["date"])
        bar = corrected_week_bar(ticker, daily_panels, week_date,
                                  float(week["open"]), float(week["low"]), float(week["close"]))

        prev_stop = entry_SL if step == 1 else float(vdf.loc[idx - 1, "vstop_line"])
        stop_path.append({"week_end": str(week_date.date()), "vstop_line": prev_stop})

        signal_mdd = min(signal_mdd, (bar["low"] - EP) / EP)

        if exit_reason is None:
            if pd.notna(prev_stop):
                if bar["open"] <= prev_stop:
                    exit_reason, exit_price = "gap_stop_at_open", bar["open"]
                    exit_week_date, sl_level_at_exit = week_date, prev_stop
                elif bar["low"] <= prev_stop:
                    exit_reason, exit_price = "stop_hit", prev_stop
                    exit_week_date, sl_level_at_exit = week_date, prev_stop
            trade_mdd = min(trade_mdd, (bar["low"] - EP) / EP)
            trade_close_for_return = exit_price if exit_reason is not None else bar["close"]
        else:
            trade_close_for_return = exit_price  # frozen -- carries forward unchanged

        if step in horizon_set:
            r_signal = round((bar["close"] - EP) / EP * 100, 4)
            r_trade = round((trade_close_for_return - EP) / EP * 100, 4)
            bench_Nw = _bench_return_at(bench, bench_close_at_signal, week_date)

            rows.append(_graded_row(ticker, as_of, step, "signal", EP, r_signal, bench_Nw,
                                     round(signal_mdd * 100, 4)))
            rows.append(_graded_row(ticker, as_of, step, "trade", EP, r_trade, bench_Nw,
                                     round(trade_mdd * 100, 4),
                                     exit_reason=exit_reason or "open",
                                     sl_hit_week=str(exit_week_date.date()) if exit_week_date is not None else None,
                                     sl_level_used=sl_level_at_exit, stop_path=list(stop_path)))
    return rows


def _fill_step_returns(rows: list[dict]) -> list[dict]:
    """R2w - R1w and R3w - R2w (the brief's "weekly step"): per (ticker, view), in
    horizon order, only between two already-graded horizons -- never against a pending
    one."""
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for r in rows:
        groups[(r["ticker"], r["view"])].append(r)
    for group in groups.values():
        group.sort(key=lambda r: r["horizon_weeks"])
        prev = None
        for r in group:
            if r["status"] == "graded" and prev is not None and prev["status"] == "graded":
                r["step_ret"] = round(r["r_Nw"] - prev["r_Nw"], 4)
            prev = r
    return rows


def grade_horizons(picks: list[dict], panels: dict[str, pd.DataFrame], as_of: pd.Timestamp,
                    horizons: list[int], bench: pd.DataFrame | None, rule_spec: dict,
                    daily_panels: dict[str, pd.DataFrame] | None = None) -> list[dict]:
    """One row per (ticker, horizon, view) -- see _graded_row/_pending_row for the
    schema. `picks` are already-built Literal pick rows (tests/track_literal.py's
    _build_picks_rows() output) carrying `ticker`, `EP`, `SL`. Used identically by the
    live maturity loop and by historical replay (tests/track_literal.py) -- same
    function, no separate replay-only grading logic (HARNESS §2 spirit)."""
    as_of = pd.Timestamp(as_of)
    daily_panels = daily_panels or {}
    horizons = sorted(set(int(h) for h in horizons))
    vstop_params = _vstop_params(rule_spec)

    bench_close_at_signal = None
    if bench is not None and not bench.empty:
        b = bench[bench["date"] <= as_of]
        if not b.empty:
            bench_close_at_signal = float(b["close"].iloc[-1])

    all_rows: list[dict] = []
    for pick in picks:
        panel = panels.get(pick["ticker"])
        if panel is None:
            all_rows.extend(_pending_row(pick["ticker"], as_of, h, v, pick.get("EP"))
                             for h in horizons for v in ("signal", "trade"))
            continue
        all_rows.extend(_grade_one_pick(pick, panel, as_of, horizons, bench, bench_close_at_signal,
                                         vstop_params, daily_panels))
    return _fill_step_returns(all_rows)
