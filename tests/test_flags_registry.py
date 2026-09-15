"""T-01: registry schema, uniqueness, countable count, checksum-on-edit."""
from __future__ import annotations

import copy

import pytest

from src.flags.registry import DEFAULT_PATH, checksum, countable_ids, diagnostic_ids, load_registry, validate_registry


def test_registry_loads_and_has_13_countable_flags():
    reg = load_registry()
    assert reg["registry_version"] == 1
    assert len(countable_ids(reg)) == 13
    assert len(set(countable_ids(reg))) == 13


def test_flag_ids_unique_across_countable_and_diagnostic():
    reg = load_registry()
    all_ids = countable_ids(reg) + diagnostic_ids(reg)
    assert len(all_ids) == len(set(all_ids))


def test_duplicate_id_raises():
    reg = load_registry()
    doc = copy.deepcopy(reg)
    doc["flags"].append(dict(doc["flags"][0]))
    with pytest.raises(ValueError):
        validate_registry(doc)


def test_wrong_countable_count_raises():
    reg = load_registry()
    doc = copy.deepcopy(reg)
    doc["flags"][0]["countable"] = False
    with pytest.raises(ValueError):
        validate_registry(doc)


def test_checksum_changes_when_threshold_edited_without_version_bump():
    reg = load_registry()
    original = checksum(reg)
    edited = copy.deepcopy(reg)
    edited["flags"][0]["rule"]["threshold"] = 999.0
    edited.pop("_computed_checksum", None)
    assert checksum(edited) != original, "editing a rule threshold must change the checksum"
    # registry_version deliberately NOT bumped here -- a caller comparing this
    # checksum against what's on disk (which the CLI's registry-lock writes)
    # is how T-01's "requires bumping registry_version" rule gets enforced in
    # practice: the disk checksum would no longer match an unbumped edit.


def test_registry_file_on_disk_matches_computed_checksum():
    """The checked-in registry's `checksum:` field was written by registry-lock
    and must match what load_registry() computes right now."""
    import yaml
    raw = yaml.safe_load(open(DEFAULT_PATH))
    reg = load_registry()
    if raw.get("checksum"):
        assert raw["checksum"] == checksum(reg)
