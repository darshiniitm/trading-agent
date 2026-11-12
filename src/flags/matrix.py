"""
Weekly flag matrix builder (docs/feature-flag-matrix-plan.md §5 stage 3, §6.1).

build_flag_matrix() is the ONLY place that turns run_screen(..., include_eligible_features=True)
output into the weekly flags_<wk>.csv row set — same funnel as Control (G2), same
PIT-sliced panels (G3). No new indicator math: every raw feature already comes
from compute_features_for_ticker() or candidate_score.guardrails().
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone

import pandas as pd

from src.flags import registry as registry_mod
from src.flags.rules import evaluate_flag
from src.flags.timing import monday_open_deadline, now_ist, resolve_mode
from src.data.adapter import KNOWN_CAVEATS
from src.screen.candidate_score import (
    BAND_POSITION_FULL_CREDIT,
    HEADROOM_FULL_CREDIT_PCT,
    LIQUIDITY_FULL_CREDIT_MULTIPLE,
    guardrails,
)
from src.screen.engine import run_screen
from src.trade.builder import _rsi_band_bounds, build_trades

GUARDRAIL_CONSTS = {
    "HEADROOM_FULL_CREDIT_PCT": HEADROOM_FULL_CREDIT_PCT,
    "LIQUIDITY_FULL_CREDIT_MULTIPLE": LIQUIDITY_FULL_CREDIT_MULTIPLE,
    "BAND_POSITION_FULL_CREDIT": BAND_POSITION_FULL_CREDIT,
}

IDENTITY_COLS = ["signal_week", "registry_version", "recording_mode", "ticker", "name", "sector", "eligible_reason"]
BASE_GATE_COLS = ["mktcap_cr", "median_weekly_turnover_cr"]
RAW_FEATURE_COLS = [
    "close", "open", "high", "low", "volume", "avg_vol_8w", "atr", "vstop_line", "uptrend", "rsi",
    "rs_4w", "rs_13w", "rs_rank", "R_pct_of_close", "risk_cap_headroom_pct", "liquidity_multiple",
    "band_position", "volume_ratio", "trend_quality",
]
SUMMARY_COLS = ["flags_met", "flags_evaluable", "flags_pct", "flags_missing_ids"]
DIAGNOSTIC_COLS = [
    "D_rsi_above_band", "D_rsi_below_band", "D_vstop_flip_down", "control_status",
    "survivor_count_week", "eligible_count_week", "market_regime_bench_above_sma30w",
]
T4_COLS = ["t4_selected", "t4_rank"]


def _round(v, dp):
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    return round(float(v), dp)


def _row_guardrails(feats: dict, rule_spec: dict) -> tuple[dict, float | None]:
    close, sl = feats.get("close"), feats.get("vstop_line")
    turnover_cr, mktcap_cr = feats.get("median_weekly_turnover_cr"), feats.get("mktcap_cr")
    if close is None or sl is None or turnover_cr is None or mktcap_cr is None or close == 0:
        return {"risk_cap_headroom_pct": None, "liquidity_multiple": None, "band_position": None}, None
    r_pct_of_close = (close - sl) / close * 100
    tc = rule_spec["trade"]
    g = guardrails(
        r_pct_of_close=r_pct_of_close, turnover_cr=turnover_cr, mktcap_cr=mktcap_cr,
        risk_cap_pct=tc["max_r_pct"], liquidity_floor_cr=rule_spec["universe"]["liquidity"]["min"],
    )
    return g, r_pct_of_close


def _market_regime(adapter, rule_spec: dict, as_of: pd.Timestamp) -> bool | None:
    bench = adapter.benchmark_series(rule_spec["sector"]["benchmark_ticker"], rule_spec["data"]["history_weeks"])
    if bench.empty:
        return None
    b = bench[bench["date"] <= as_of].sort_values("date")
    if len(b) < 30:
        return None
    sma30 = b["close"].tail(30).mean()
    return bool(b["close"].iloc[-1] > sma30)


def build_flag_matrix(as_of: pd.Timestamp, rule_spec: dict, registry: dict, adapter,
                       universe_df: pd.DataFrame, panels: dict, shares: dict,
                       created_at: datetime | None = None) -> tuple[pd.DataFrame, dict]:
    as_of = pd.Timestamp(as_of)
    created_at = created_at or now_ist()
    mode = resolve_mode(as_of, created_at)

    res = run_screen(as_of, rule_spec, adapter, universe_df, panels, shares, include_eligible_features=True)
    eligible = res["eligible_features"]
    survivors = res["survivors"]
    near_miss = res["near_miss"]
    funnel = {k: int(v) for k, v in zip(res["funnel"]["stage"], res["funnel"]["count"])}

    trades = build_trades(survivors, rule_spec)
    trade_tickers = set(trades["ticker"]) if not trades.empty else set()
    survivor_tickers = set(survivors["ticker"]) if not survivors.empty else set()
    near_miss_status = {}
    if not near_miss.empty:
        for _, nm in near_miss.iterrows():
            near_miss_status[nm["ticker"]] = f"NEAR_MISS_failed_{'+'.join(nm['failed_signals'])}"

    rsi_lo, rsi_hi = _rsi_band_bounds(rule_spec)
    ctx = {
        "rsi_lo": rsi_lo, "rsi_hi": rsi_hi,
        "max_r_pct": rule_spec["trade"]["max_r_pct"],
        "sector_outperforming_rs_gt": rule_spec["sector"]["outperforming"]["rs_gt"],
        "guardrail_consts": GUARDRAIL_CONSTS,
    }
    countable = [f for f in registry["flags"] if f["countable"]]
    diagnostics_flags = {f["id"]: f for f in registry["flags"] if not f["countable"]}

    regime = _market_regime(adapter, rule_spec, as_of)
    survivor_count = len(survivors)
    eligible_count = len(eligible)

    rows = []
    for _, feats in eligible.iterrows():
        feats = feats.to_dict()
        ticker = feats["ticker"]
        row = {
            "signal_week": str(as_of.date()), "registry_version": registry["registry_version"],
            "recording_mode": mode, "ticker": ticker, "name": feats.get("name"), "sector": feats.get("sector"),
            "eligible_reason": feats.get("eligible_reason"),
            "mktcap_cr": _round(feats.get("mktcap_cr"), 4),
            "median_weekly_turnover_cr": _round(feats.get("median_weekly_turnover_cr"), 4),
        }

        if feats.get("eligible_reason") == "insufficient_history":
            for c in RAW_FEATURE_COLS + [f["id"] for f in countable] + SUMMARY_COLS + list(diagnostics_flags):
                row[c] = None
            row["flags_missing_ids"] = ""
        else:
            g, r_pct_of_close = _row_guardrails(feats, rule_spec)
            volume_ratio = (feats.get("volume") / feats.get("avg_vol_8w")) if feats.get("avg_vol_8w") else None
            trend_quality = ((feats.get("close") - feats.get("vstop_line")) / feats.get("atr")
                              if feats.get("atr") and feats.get("vstop_line") is not None else None)

            eval_row = {**feats, **g}
            row.update({
                "close": _round(feats.get("close"), 4), "open": _round(feats.get("open"), 4),
                "high": _round(feats.get("high"), 4), "low": _round(feats.get("low"), 4),
                "volume": _round(feats.get("volume"), 4), "avg_vol_8w": _round(feats.get("avg_vol_8w"), 4),
                "atr": _round(feats.get("atr"), 4), "vstop_line": _round(feats.get("vstop_line"), 4),
                "uptrend": bool(feats.get("uptrend")), "rsi": _round(feats.get("rsi"), 4),
                "rs_4w": _round(feats.get("rs_4w"), 4), "rs_13w": _round(feats.get("rs_13w"), 4),
                "rs_rank": feats.get("rs_rank"), "R_pct_of_close": _round(r_pct_of_close, 3),
                "risk_cap_headroom_pct": _round(g.get("risk_cap_headroom_pct"), 3),
                "liquidity_multiple": _round(g.get("liquidity_multiple"), 4),
                "band_position": _round(g.get("band_position"), 4),
                "volume_ratio": _round(volume_ratio, 4), "trend_quality": _round(trend_quality, 4),
            })

            met, evaluable, missing = 0, 0, []
            for f in countable:
                val = evaluate_flag(f, eval_row, ctx)
                row[f["id"]] = val
                if val is not None:
                    evaluable += 1
                    met += val
                else:
                    missing.append(f["id"])
            row["flags_met"] = met
            row["flags_evaluable"] = evaluable
            row["flags_pct"] = _round(met / evaluable, 3) if evaluable else None
            row["flags_missing_ids"] = ";".join(missing)

            for fid, f in diagnostics_flags.items():
                row[fid] = evaluate_flag(f, eval_row, ctx)

        if ticker in trade_tickers:
            row["control_status"] = "TRADE"
        elif ticker in survivor_tickers:
            row["control_status"] = "SHADOW_rejected_by_risk_cap"
        else:
            row["control_status"] = near_miss_status.get(ticker, "NONE")
        row["survivor_count_week"] = survivor_count
        row["eligible_count_week"] = eligible_count
        row["market_regime_bench_above_sma30w"] = regime
        row["t4_selected"] = None
        row["t4_rank"] = None
        rows.append(row)

    columns = IDENTITY_COLS + BASE_GATE_COLS + RAW_FEATURE_COLS + [f["id"] for f in countable] \
        + SUMMARY_COLS + DIAGNOSTIC_COLS + T4_COLS
    df = pd.DataFrame(rows)
    if df.empty:
        df = pd.DataFrame(columns=columns)
    else:
        df = df.reindex(columns=columns)
        df = df.sort_values(["flags_met", "ticker"], ascending=[False, True], na_position="last").reset_index(drop=True)

    manifest = {
        "record_id": f"flags_{as_of.date()}",
        "signal_week": str(as_of.date()),
        "holding_week": str((as_of + pd.Timedelta(weeks=1)).date()),
        "recording_mode": mode,
        "created_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "created_ist": created_at.isoformat(timespec="seconds"),
        "monday_open_deadline_ist": monday_open_deadline(as_of).isoformat(timespec="seconds"),
        "registry_version": registry["registry_version"],
        "registry_checksum": registry_mod.checksum(registry),
        "data": {"n_panels": len(panels), "benchmark_ticker": rule_spec["sector"]["benchmark_ticker"]},
        "funnel": funnel,
        "counts": {
            "rows": len(df),
            "flags_met_histogram": (df["flags_met"].value_counts().sort_index().astype(int).to_dict()
                                     if not df.empty else {}),
            "prevalence_by_flag": ({f["id"]: round(float(df[f["id"]].mean()), 4) for f in countable if not df.empty
                                     and df[f["id"]].notna().any()}),
        },
        "t4": {"k": registry.get("t4", {}).get("k"), "selected": []},
        "checks": [],
        # G12: every output carries the canonical caveats regardless of which adapter
        # produced the data (OfflineAdapter's test-fixture caveats() intentionally
        # returns [] — it's a hermeticity fixture, not a second source of truth).
        "caveats": list(KNOWN_CAVEATS),
    }
    return df, manifest


def csv_sha256(path) -> str:
    return "sha256:" + hashlib.sha256(open(path, "rb").read()).hexdigest()
