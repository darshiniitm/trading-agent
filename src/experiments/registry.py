"""Load/validate config/experiments.yaml (docs/open-decisions-implementation-plan.md P2)."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PATH = ROOT / "config" / "experiments.yaml"
REQUIRED = ("id", "name", "counts_toward_budget", "mechanism", "rule", "segment", "kill", "finalist")
FROZEN_FIELDS = ("id", "rule", "segment", "kill", "counts_toward_budget")


def _checksum(doc: dict) -> str:
    block = [{k: e[k] for k in FROZEN_FIELDS} for e in doc["experiments"]]
    return "sha256:" + hashlib.sha256(json.dumps(block, sort_keys=True).encode()).hexdigest()


def validate(doc: dict) -> None:
    ids = [e.get("id") for e in doc.get("experiments", [])]
    if len(ids) != len(set(ids)):
        raise ValueError("duplicate experiment id")
    for e in doc["experiments"]:
        missing = [k for k in REQUIRED if k not in e]
        if missing:
            raise ValueError(f"{e.get('id')}: missing {missing}")
        for dep in e.get("depends_on", []):
            if dep not in ids:
                raise ValueError(f"{e['id']} depends on unregistered {dep}")
    used = sum(1 for e in doc["experiments"] if e["counts_toward_budget"])
    if used > doc["budget"]:
        raise ValueError(f"variant budget exceeded: {used} > {doc['budget']}")


def load(path: str | Path = DEFAULT_PATH) -> dict:
    doc = yaml.safe_load(Path(path).read_text())
    validate(doc)
    if doc.get("checksum") not in (None, _checksum(doc)):
        raise ValueError("config/experiments.yaml registered fields were edited after lock — add a new id instead")
    return doc


def get_experiment(experiment_id: str | None, path: str | Path = DEFAULT_PATH) -> dict:
    for e in load(path)["experiments"]:
        if e["id"] == experiment_id:
            return e
    raise KeyError(f"experiment {experiment_id!r} is not registered in config/experiments.yaml")


def lock(path: str | Path = DEFAULT_PATH) -> str:
    text = Path(path).read_text()
    doc = yaml.safe_load(text)
    validate(doc)
    value = _checksum(doc)
    if doc.get("checksum") not in (None, value):
        raise ValueError("already locked with a different checksum")
    Path(path).write_text("\n".join(f"checksum: '{value}'" if ln.startswith("checksum:") else ln
                                    for ln in text.splitlines()) + "\n")
    return value
