from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

REGISTRY_PATH = Path("results/prompt_arms/registry.json")


def _read() -> dict:
    if not REGISTRY_PATH.exists():
        return {}
    return json.loads(REGISTRY_PATH.read_text())


def _write(body: dict) -> None:
    REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
    REGISTRY_PATH.write_text(json.dumps(body, indent=2))


def register_arm(prompt_id: int, program: dict, structure: str = "literal") -> None:
    body = _read()
    body[str(prompt_id)] = {
        "structure": structure, "program_version": program.get("program_version"), "status": "active",
        "registered_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    _write(body)


def retire_arm(prompt_id: int) -> None:
    body = _read()
    if str(prompt_id) in body:
        body[str(prompt_id)]["status"] = "retired"
        _write(body)


def is_active(prompt_id: int) -> bool:
    return _read().get(str(prompt_id), {}).get("status") == "active"
