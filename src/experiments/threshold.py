"""
Threshold experiment — risk-cap sweep, shadow only (docs/threshold-experiment-plan.md).

Each arm `threshold-experiment_<cap>` answers: "if build_trades()'s risk cap were <cap>%
instead of Control's 15%, which of this week's survivors would be SELECTED (R/EP <= cap) and
which REJECTED (R/EP > cap), and how did each group do over the holding week?"

Design rules (HARNESS §12):
  * Inputs are ONLY Control's own picks_<wk>.json — which already lists every survivor
    (TRADE and SHADOW_rejected_by_risk_cap) — and that file's own `graded.detail`.
    No second run_screen()/build_trades(), no price reads, no re-grading.
  * Nothing here changes config/rules.yaml, run_screen() or build_trades().
  * Equal weight. A week with zero SELECTED names counts as 0.0% (cash), never dropped.
    A week with zero REJECTED names has no rejected basket (None) — there was nothing to observe.
"""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd
import yaml

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PATH = ROOT / "config" / "threshold_experiment.yaml"
REQUIRED_KEYS = ("experiment", "registered_on", "caps_pct", "control_cap_pct", "cap_inclusive",
                 "primary_metric", "checksum")
SELECTED, REJECTED = "SELECTED", "REJECTED"


# ---------------------------------------------------------------- registry
def _checksum_block(doc: dict) -> str:
    block = {k: doc[k] for k in ("experiment", "caps_pct", "control_cap_pct", "cap_inclusive", "primary_metric")}
    payload = json.dumps(block, sort_keys=True, default=str)
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def checksum(doc: dict) -> str:
    return _checksum_block(doc)


def validate_registry(doc: dict, rule_spec: dict | None = None) -> None:
    missing = [k for k in REQUIRED_KEYS if k not in doc]
    if missing:
        raise ValueError(f"threshold registry missing keys: {missing}")
    caps = [float(c) for c in doc["caps_pct"]]
    if not caps or any(c <= 0 for c in caps):
        raise ValueError("caps_pct must be a non-empty list of positive numbers")
    if caps != sorted(caps) or len(set(caps)) != len(caps):
        raise ValueError("caps_pct must be strictly increasing with no duplicates")
    if float(doc["control_cap_pct"]) not in caps:
        raise ValueError("control_cap_pct must be one of caps_pct")
    if doc["cap_inclusive"] is not True:
        raise ValueError("cap_inclusive must be true to mirror build_trades() (rejects only R/EP > cap)")
    if rule_spec is not None:
        control = round(float(rule_spec["trade"]["max_r_pct"]) * 100, 6)
        if round(float(doc["control_cap_pct"]), 6) != control:
            raise ValueError(f"control_cap_pct={doc['control_cap_pct']} but rules.yaml trade.max_r_pct*100={control}; "
                             "the experiment's reference arm must be Control's real cap")


def load_registry(path: str | Path = DEFAULT_PATH, rule_spec: dict | None = None) -> dict:
    with open(path) as f:
        doc = yaml.safe_load(f)
    validate_registry(doc, rule_spec)
    stored = doc.get("checksum")
    if stored is not None and stored != _checksum_block(doc):
        raise ValueError("config/threshold_experiment.yaml was edited after registry-lock "
                         "(checksum mismatch) — register a new experiment name instead of editing caps")
    return doc


def write_checksum(path: str | Path = DEFAULT_PATH) -> str:
    """registry-lock: write the checksum line in place (keeps the file's comments)."""
    text = Path(path).read_text()
    doc = yaml.safe_load(text)
    validate_registry(doc)
    value = _checksum_block(doc)
    if doc.get("checksum") not in (None, value):
        raise ValueError("checksum already set to a different value — the registry was edited after lock")
    lines = [f"checksum: '{value}'" if ln.startswith("checksum:") else ln for ln in text.splitlines()]
    Path(path).write_text("\n".join(lines) + "\n")
    return value


# ---------------------------------------------------------------- naming / membership
def cap_label(cap: float) -> str:
    return f"{float(cap):g}"


def arm_name(cap: float, experiment: str = "threshold-experiment") -> str:
    return f"{experiment}_{cap_label(cap)}"


def r_ratio(row: dict) -> float | None:
    """R / EP at record time, exactly as build_trades() computes it live: EP = signal close,
    SL = vstop_line. None when the row has no usable stop."""
    close, sl = row.get("signal_close"), row.get("vstop_line_SL")
    if close is None or sl is None:
        return None
    close, sl = float(close), float(sl)
    if close == 0 or np.isnan(close) or np.isnan(sl):
        return None
    return (close - sl) / close


def is_selected(ratio: float, cap_pct: float) -> bool:
    """Mirror of build_trades(): reject iff R/EP > max_r_pct. Compared as ratios, not rounded %."""
    return not (ratio > float(cap_pct) / 100.0)


def build_membership(picks: list[dict], registry: dict) -> tuple[list[dict], dict]:
    """Returns (rows, arms). rows: one per survivor with r_pct and one SELECTED/REJECTED column per
    arm. arms: {arm_name: {cap_pct, selected: [...], rejected: [...]}} (tickers sorted)."""
    exp = registry["experiment"]
    caps = [float(c) for c in registry["caps_pct"]]
    rows = []
    arms = {arm_name(c, exp): {"cap_pct": c, "selected": [], "rejected": []} for c in caps}
    for p in picks:
        ratio = r_ratio(p)
        row = {
            "ticker": p["ticker"], "name": p.get("name"), "sector": p.get("sector"),
            "control_status": p.get("status"), "signal_close": p.get("signal_close"),
            "vstop_line_SL": p.get("vstop_line_SL"),
            "r_pct": round(ratio * 100, 4) if ratio is not None else None,
            "confidence": p.get("confidence"),
        }
        for c in caps:
            name = arm_name(c, exp)
            if ratio is None:
                row[name] = None
                continue
            status = SELECTED if is_selected(ratio, c) else REJECTED
            row[name] = status
            arms[name]["selected" if status == SELECTED else "rejected"].append(p["ticker"])
        rows.append(row)
    for a in arms.values():
        a["selected"].sort()
        a["rejected"].sort()
    return rows, arms


def picks_fingerprint(picks_record: dict) -> str:
    """sha256 of Control's picks record with the `graded` block removed — grade() legitimately
    fills that block later, everything else must never change (HARNESS §4)."""
    body = {k: v for k, v in picks_record.items() if k != "graded"}
    payload = json.dumps(body, sort_keys=True, default=str)
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- invariants
def _check(id_: str, ok: bool, detail: str) -> dict:
    return {"id": id_, "status": "PASS" if ok else "FAIL", "detail": detail}


def check_record(rows: list[dict], arms: dict, picks: list[dict], registry: dict) -> list[dict]:
    exp = registry["experiment"]
    control = arm_name(registry["control_cap_pct"], exp)
    trade = sorted(p["ticker"] for p in picks if p.get("status") == "TRADE")
    checks = [_check("X1", arms[control]["selected"] == trade,
                     f"{control} selected={arms[control]['selected']} vs Control TRADE={trade}")]
    names = [arm_name(c, exp) for c in registry["caps_pct"]]
    nested = all(set(arms[a]["selected"]) <= set(arms[b]["selected"]) for a, b in zip(names, names[1:]))
    checks.append(_check("X2", nested, "selected sets nested by increasing cap"))
    valid = sorted(r["ticker"] for r in rows if r["r_pct"] is not None)
    x3 = all(sorted(arms[n]["selected"] + arms[n]["rejected"]) == valid
             and not set(arms[n]["selected"]) & set(arms[n]["rejected"]) for n in names)
    checks.append(_check("X3", x3, f"every arm partitions the {len(valid)} survivors with a usable stop"))
    return checks


# ---------------------------------------------------------------- grading
def _basket(detail_by_ticker: dict, tickers: list[str]) -> dict:
    vals = [float(detail_by_ticker[t]["ret_pct_net"]) for t in tickers if t in detail_by_ticker]
    if not vals:
        return {"n": 0, "net_pct": None, "winners": 0, "worst_pct": None}
    return {"n": len(vals), "net_pct": round(float(np.mean(vals)), 3),
            "winners": int(sum(v > 0 for v in vals)), "worst_pct": round(float(min(vals)), 3)}


def grade_record(record: dict, picks_record: dict, registry: dict) -> tuple[dict, list[dict], list[dict]]:
    """Returns (graded_block, ledger_rows, checks). Uses only picks_record['graded']['detail']."""
    graded = picks_record["graded"]
    detail = {d["ticker"]: d for d in graded.get("detail", [])}
    exp = registry["experiment"]
    control = arm_name(registry["control_cap_pct"], exp)

    missing = sorted({t for a in record["arms"].values() for t in a["selected"] + a["rejected"]} - set(detail))
    per_arm = {}
    for name, a in record["arms"].items():
        sel, rej = _basket(detail, a["selected"]), _basket(detail, a["rejected"])
        per_arm[name] = {
            "cap_pct": a["cap_pct"],
            "selected_n": sel["n"],
            "selected_basket_net_pct": sel["net_pct"] if sel["n"] else 0.0,   # no names = cash = 0.0%
            "selected_winners": sel["winners"],
            "selected_worst_trade_pct": sel["worst_pct"],
            "rejected_n": rej["n"],
            "rejected_basket_net_pct": rej["net_pct"],                       # None when nothing was rejected
            "rejected_winners": rej["winners"],
            "rejected_worst_trade_pct": rej["worst_pct"],
        }
    ctrl_net = per_arm[control]["selected_basket_net_pct"]
    for v in per_arm.values():
        v["selected_minus_control_pct"] = round(v["selected_basket_net_pct"] - ctrl_net, 3)
        v["selected_minus_rejected_pct"] = (round(v["selected_basket_net_pct"] - v["rejected_basket_net_pct"], 3)
                                            if v["rejected_basket_net_pct"] is not None and v["selected_n"] else None)

    expected = graded.get("basket_net_pct")
    expected = 0.0 if expected is None else float(expected)
    checks = [
        _check("X4", record["picks_fingerprint"] == picks_fingerprint(picks_record),
               "Control picks record unchanged since the threshold record was written (graded block excluded)"),
        _check("X5", not missing, f"every member has a graded row; missing={missing}"),
        _check("X6", abs(ctrl_net - expected) < 0.0015,
               f"{control} selected basket {ctrl_net} vs Control graded basket_net_pct {expected}"),
    ]
    ledger_rows = [{
        "experiment": exp, "recording_mode": record["recording_mode"], "signal_week": record["signal_week"],
        "arm": name, **vals,
        "benchmark_week_pct": graded.get("benchmark_week_pct"),
    } for name, vals in per_arm.items()]
    block = {"per_arm": per_arm, "control_arm": control, "checks": checks,
             "benchmark_week_pct": graded.get("benchmark_week_pct")}
    return block, ledger_rows, checks


# ---------------------------------------------------------------- summary
def summarize(ledger: pd.DataFrame, registry: dict, modes=("forward",)) -> pd.DataFrame:
    from src.backtest.harness import bootstrap_ci
    from src.flags.scorecard import _bh_correction, _bootstrap_pvalue, maturity_label

    exp = registry["experiment"]
    control = arm_name(registry["control_cap_pct"], exp)
    df = ledger[ledger["recording_mode"].isin(modes)] if not ledger.empty else ledger
    out, pvals = [], {}
    for c in registry["caps_pct"]:
        name = arm_name(c, exp)
        a = df[df["arm"] == name].sort_values("signal_week") if not df.empty else df
        n_weeks = int(len(a))
        sel = a["selected_basket_net_pct"].astype(float).to_numpy() if n_weeks else np.array([])
        diff = a["selected_minus_control_pct"].astype(float).to_numpy() if n_weeks else np.array([])
        rej = a["rejected_basket_net_pct"].dropna().astype(float).to_numpy() if n_weeks else np.array([])
        s_mean, s_lo, s_hi = bootstrap_ci(sel)
        d_mean, d_lo, d_hi = bootstrap_ci(diff)
        r_mean, r_lo, r_hi = bootstrap_ci(rej)
        differs = int((diff != 0).sum()) if n_weeks else 0
        if name != control and differs:
            pvals[name] = _bootstrap_pvalue(diff)
        sel_n = int(a["selected_n"].sum()) if n_weeks else 0
        wins = int(a["selected_winners"].sum()) if n_weeks else 0
        out.append({
            "arm": name, "cap_pct": c, "is_control": name == control, "weeks": n_weeks,
            "maturity": maturity_label(n_weeks), "weeks_differing_from_control": differs,
            "selected_trades": sel_n, "selected_hit_rate": round(wins / sel_n, 3) if sel_n else None,
            "selected_weekly_mean_pct": s_mean, "selected_ci_lo": s_lo, "selected_ci_hi": s_hi,
            "minus_control_mean_pct": d_mean, "minus_control_ci_lo": d_lo, "minus_control_ci_hi": d_hi,
            "rejected_trades": int(a["rejected_n"].sum()) if n_weeks else 0,
            "rejected_weeks": int(len(rej)),
            "rejected_weekly_mean_pct": r_mean, "rejected_ci_lo": r_lo, "rejected_ci_hi": r_hi,
            "worst_selected_trade_pct": (float(a["selected_worst_trade_pct"].min())
                                         if n_weeks and a["selected_worst_trade_pct"].notna().any() else None),
        })
    q = _bh_correction(pvals) if pvals else {}
    res = pd.DataFrame(out)
    res["minus_control_p"] = res["arm"].map(pvals)
    res["minus_control_q_bh"] = res["arm"].map(q)
    return res
