"""Per-user engine API keys: hashed storage, per-key revoke, rate limit, size cap (Engine Production Plan, Phase 3)."""
from __future__ import annotations

from fastapi.testclient import TestClient

from engine.app import create_app
from engine.apikeys import KeyAuth, MemoryStore, RateLimiter, hash_key


def _client(monkeypatch, **env):
    monkeypatch.delenv("ENGINE_TOKEN", raising=False)
    monkeypatch.setenv("API_PEPPER", "pepper")
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    store = MemoryStore()
    auth = KeyAuth(store, "pepper")
    return TestClient(create_app(offline=True, key_store=store)), auth, store


def test_only_a_keyed_hash_is_stored(monkeypatch):
    _, auth, store = _client(monkeypatch)
    key_id, key = auth.issue("alice")
    assert key not in str(store.rows) and store.rows[key_id]["key_hash"] == hash_key(key, "pepper")
    assert hash_key(key, "pepper") != hash_key(key, "other-pepper")


def test_valid_key_passes_and_garbage_is_rejected(monkeypatch):
    client, auth, _ = _client(monkeypatch)
    _, key = auth.issue("alice")
    assert client.post("/warmup/retry", headers={"Authorization": f"Bearer {key}"}).status_code == 200
    assert client.post("/warmup/retry", headers={"Authorization": "Bearer ek_nope_nope"}).status_code == 401
    assert client.post("/warmup/retry").status_code == 401


def test_revoking_one_key_leaves_the_others_working(monkeypatch):
    client, auth, store = _client(monkeypatch)
    id_a, key_a = auth.issue("a")
    _, key_b = auth.issue("b")
    assert store.revoke(id_a)
    assert client.post("/warmup/retry", headers={"Authorization": f"Bearer {key_a}"}).status_code == 401
    assert client.post("/warmup/retry", headers={"Authorization": f"Bearer {key_b}"}).status_code == 200


def test_shared_engine_token_still_works_beside_user_keys(monkeypatch):
    client, _, _ = _client(monkeypatch, ENGINE_TOKEN="shared")
    assert client.post("/warmup/retry", headers={"Authorization": "Bearer shared"}).status_code == 200


def test_health_stays_open(monkeypatch):
    client, _, _ = _client(monkeypatch)
    assert client.get("/health").status_code == 200


def test_per_key_rate_limit(monkeypatch):
    client, auth, _ = _client(monkeypatch, API_RATE_LIMIT_PER_MIN="2")
    _, key = auth.issue("a")
    h = {"Authorization": f"Bearer {key}"}
    assert [client.post("/warmup/retry", headers=h).status_code for _ in range(3)] == [200, 200, 429]


def test_rate_limiter_window_slides():
    t = [0.0]
    rl = RateLimiter(1, clock=lambda: t[0])
    assert rl.allow("k") and not rl.allow("k")
    t[0] = 61
    assert rl.allow("k")


def test_oversized_request_is_refused(monkeypatch):
    client, auth, _ = _client(monkeypatch, API_MAX_BODY_BYTES="10")
    _, key = auth.issue("a")
    r = client.post("/warmup/retry", headers={"Authorization": f"Bearer {key}"}, content=b"x" * 50)
    assert r.status_code == 413
