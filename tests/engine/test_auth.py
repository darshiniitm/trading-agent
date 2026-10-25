"""Engine bearer-token auth (docs/netlify-production-plan.md §5.2): off locally, on when ENGINE_TOKEN is set."""
from __future__ import annotations

from fastapi.testclient import TestClient

from engine.app import create_app


def test_no_token_configured_leaves_every_route_open(monkeypatch):
    monkeypatch.delenv("ENGINE_TOKEN", raising=False)
    client = TestClient(create_app(offline=True))
    assert client.get("/health").status_code == 200
    assert client.post("/warmup/retry").status_code == 200


def test_token_configured_rejects_requests_without_or_with_a_wrong_bearer(monkeypatch):
    monkeypatch.setenv("ENGINE_TOKEN", "s3cret-token")
    client = TestClient(create_app(offline=True))
    assert client.post("/warmup/retry").status_code == 401
    assert client.post("/warmup/retry", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert client.post("/warmup/retry", headers={"Authorization": "s3cret-token"}).status_code == 401   # not a Bearer scheme


def test_token_configured_accepts_the_right_bearer(monkeypatch):
    monkeypatch.setenv("ENGINE_TOKEN", "s3cret-token")
    client = TestClient(create_app(offline=True))
    assert client.post("/warmup/retry", headers={"Authorization": "Bearer s3cret-token"}).status_code == 200


def test_health_stays_open_so_the_host_can_probe_it(monkeypatch):
    monkeypatch.setenv("ENGINE_TOKEN", "s3cret-token")
    client = TestClient(create_app(offline=True))
    assert client.get("/health").status_code == 200
