from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import pytest
from fastapi.testclient import TestClient

from engine.app import create_app
from engine.env import load_environment


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app(offline=True))


@pytest.fixture
def literal_env():
    return load_environment("literal", offline=True)
