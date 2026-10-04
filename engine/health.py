from __future__ import annotations

import subprocess
from pathlib import Path

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


def health_payload(last_bar_date: str | None = None, data_snapshot_hash: str | None = None) -> dict:
    return {
        "status": "ok",
        "engine_git_sha": engine_git_sha(),
        "last_bar_date": last_bar_date,
        "data_snapshot_hash": data_snapshot_hash,
    }
