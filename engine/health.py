from __future__ import annotations

import subprocess
from pathlib import Path

from engine.env import load_environment, last_bar_date

ROOT = Path(__file__).resolve().parents[1]


def engine_git_sha() -> str:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=ROOT, capture_output=True, text=True, timeout=5, check=True,
        )
        return out.stdout.strip()
    except Exception:
        return "unknown"


def health_payload(offline: bool = False) -> dict:
    """Never loads market data itself: while the engine is still warming it reports where it is (the app shows that)."""
    from engine.warmup import STATE
    warm = STATE.snapshot()
    if offline:
        warm = {**warm, "state": "ready", "retryable": False}
    bar_date = None
    if warm["state"] == "ready":
        try:
            bar_date = last_bar_date(load_environment("literal", offline=offline))
        except Exception:
            bar_date = None
    return {
        "status": "ok",
        "engine_git_sha": engine_git_sha(),
        "last_bar_date": bar_date,
        "data_snapshot_hash": None,
        "warm": warm,
    }
