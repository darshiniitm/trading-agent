"""
Load + validate the feature-flag registry (config/feature_flags.yaml).

The registry is NOT Control (see docs/feature-flag-matrix-plan.md §3.4).
Any edit to a threshold or to the countable-flag set requires bumping
registry_version (§8.4) — enforced here via a checksum over the
flags+t4 block, written by `registry-lock` and checked on every load
against what's actually on disk (checked by the caller, not this module,
since a checksum *mismatch* by itself isn't an error — only a version
bump that doesn't accompany a real change, or vice versa, matters at the
call site).
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import yaml

DEFAULT_PATH = Path(__file__).resolve().parents[2] / "config" / "feature_flags.yaml"


def _checksum_block(doc: dict) -> str:
    block = {"flags": doc["flags"], "t4": doc["t4"]}
    payload = json.dumps(block, sort_keys=True, default=str)
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def load_registry(path: str | Path = DEFAULT_PATH) -> dict:
    with open(path) as f:
        doc = yaml.safe_load(f)
    validate_registry(doc)
    doc["_computed_checksum"] = _checksum_block(doc)
    return doc


def validate_registry(doc: dict) -> None:
    ids = [f["id"] for f in doc["flags"]]
    if len(ids) != len(set(ids)):
        dupes = sorted({i for i in ids if ids.count(i) > 1})
        raise ValueError(f"duplicate flag ids in registry: {dupes}")
    countable = [f for f in doc["flags"] if f.get("countable")]
    if len(countable) != 13:
        raise ValueError(f"registry_version {doc.get('registry_version')} must have exactly "
                          f"13 countable flags, found {len(countable)}")
    for f in doc["flags"]:
        if "rule" not in f or "type" not in f["rule"]:
            raise ValueError(f"flag {f['id']} missing rule.type")


def countable_ids(doc: dict) -> list[str]:
    return [f["id"] for f in doc["flags"] if f.get("countable")]


def diagnostic_ids(doc: dict) -> list[str]:
    return [f["id"] for f in doc["flags"] if not f.get("countable")]


def checksum(doc: dict) -> str:
    return doc.get("_computed_checksum") or _checksum_block(doc)


def write_checksum(path: str | Path = DEFAULT_PATH, t4_k: int | None = None) -> str:
    """`registry-lock`: writes the computed checksum (and, once, t4.k) back to the
    YAML file. Refuses to change an already-set K within a version (§11.1)."""
    with open(path) as f:
        raw_text = f.read()
    doc = yaml.safe_load(raw_text)
    validate_registry(doc)

    if t4_k is not None:
        existing_k = doc["t4"].get("k")
        if existing_k is not None and existing_k != t4_k:
            raise ValueError(f"t4.k is already frozen at {existing_k} for registry_version "
                              f"{doc['registry_version']}; cannot change to {t4_k} without a new version")
        doc["t4"]["k"] = t4_k

    doc["checksum"] = _checksum_block(doc)
    with open(path, "w") as f:
        yaml.safe_dump(doc, f, sort_keys=False)
    return doc["checksum"]
