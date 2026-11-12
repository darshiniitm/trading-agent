from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import pytest
from fastapi.testclient import TestClient

from engine.app import create_app
from engine.env import load_environment


LITERAL_CACHE = ROOT / "data_cache_literal" / "weekly_ohlcv_260w.parquet"


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    """data_cache_literal/ is gitignored, so CI has no frozen bars: a test that needs them is skipped there, not failed.
    Only a missing-cache FileNotFoundError, and only when the cache really is absent; anything else still fails."""
    outcome = yield
    rep = outcome.get_result()
    exc = call.excinfo
    if (exc is not None and not LITERAL_CACHE.exists() and exc.errisinstance(FileNotFoundError)
            and "data_cache_literal" in str(exc.value)):
        rep.outcome = "skipped"
        rep.longrepr = (str(item.path), item.location[1] or 0, "Skipped: frozen data_cache_literal/ is not on this machine")


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app(offline=True))


@pytest.fixture
def literal_env():
    return load_environment("literal", offline=True)
