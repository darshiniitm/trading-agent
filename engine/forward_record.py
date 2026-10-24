from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

OUT_DIR = Path("results/prompt_arms")


def write_record(prompt_id: int, as_of: pd.Timestamp, entered: list[dict], program: dict, structure: str = "literal",
                 scored: bool = True) -> Path | None:
    for row in entered:
        if "entry_price" not in row:
            raise ValueError(f"row for {row.get('ticker')} has no entry_price — only entered picks may be recorded")

    as_of = pd.Timestamp(as_of)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / f"picks_{prompt_id}_{as_of.date()}.json"
    if path.exists():
        return None

    record = {
        "prompt_id": prompt_id,
        "as_of": str(as_of.date()),
        "created_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "structure": structure, "program": program,
        "scored": scored,            # partial / low-coverage runs stay visible but do not count (data-fallback spec §7)
        "picks": entered,
        "graded": None,
    }
    path.write_text(json.dumps(record, indent=2))
    return path
