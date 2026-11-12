"""Shared fixtures keep this identical to web/src/server/telemetry/redact.ts (observability/redaction-fixtures.json)."""
import json
from pathlib import Path

import pytest

from src.telemetry.redact import hash_user, redact_string, redact_value, truncate

FX = json.loads((Path(__file__).resolve().parents[2] / "observability" / "redaction-fixtures.json").read_text())


@pytest.mark.parametrize("c", FX["strings"], ids=lambda c: c["name"])
def test_strings(c):
    assert redact_string(c["in"]) == c["out"]


@pytest.mark.parametrize("c", FX["objects"], ids=lambda c: c["name"])
def test_objects(c):
    assert redact_value(c["in"]) == c["out"]


@pytest.mark.parametrize("c", FX["hash_user"]["cases"])
def test_hash_user(c):
    assert hash_user(c["in"], FX["hash_user"]["salt"]) == c["out"]


@pytest.mark.parametrize("c", FX["truncate"]["cases"])
def test_truncate(c):
    assert truncate(c["in"], FX["truncate"]["max"]) == (c["text"], c["truncated"])


def test_token_counts_are_not_secrets():
    assert redact_value({"input_tokens": 12, "output_tokens": 3, "tokens": 9}) == {"input_tokens": 12, "output_tokens": 3, "tokens": 9}


def test_does_not_mutate_and_tolerates_cycles():
    a = {"password": "p", "n": {"k": "v"}}
    a["self"] = a
    out = redact_value(a)
    assert a["password"] == "p" and out["password"] == "[redacted]" and out["self"] == "[circular]"


def test_truncate_default_16kb():
    t, flag = truncate("x" * 20000)
    assert len(t) == 16384 and flag
