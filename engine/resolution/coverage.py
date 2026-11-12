"""Run coverage and status (spec §7)."""
from __future__ import annotations

from engine.resolution.config import load_config


def compute_coverage(universe_size: int, outcomes: dict[str, dict], per_condition_counts: dict[str, list[int]],
                     universe_quality: str, unfeedable: list[str], config: dict | None = None) -> dict:
    """outcomes: ticker -> {"outcome": qualified|rejected|unevaluated}. per_condition_counts: cid -> [evaluated, attempted]."""
    cfg = (config or load_config())["coverage"]
    full = sum(1 for o in outcomes.values() if o["outcome"] != "unevaluated")
    cov = full / universe_size if universe_size else 0.0
    per = {cid: (ev / att if att else 0.0) for cid, (ev, att) in per_condition_counts.items()}
    for cid in unfeedable:
        per[cid] = 0.0
    if cov < cfg["partial_min"]:
        status = "low_coverage"
    elif cov >= cfg["complete_min"] and not unfeedable and universe_quality in ("ok", "fallback"):
        status = "complete"
    else:
        status = "partial"
    return {"universe_size": universe_size, "fully_evaluated": full, "coverage": round(cov, 4),
            "per_condition": per, "universe_quality": universe_quality,
            "unfeedable_conditions": list(unfeedable), "status": status}


def is_scored(status: str, config: dict | None = None) -> bool:
    cfg = config or load_config()
    return status == "complete" or not cfg["scoring"]["exclude_partial_runs"]
