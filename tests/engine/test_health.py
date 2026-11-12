def test_health_returns_ok_and_git_sha(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert isinstance(body["engine_git_sha"], str) and len(body["engine_git_sha"]) > 0
    from tests.engine.conftest import LITERAL_CACHE
    if LITERAL_CACHE.exists():   # offline env is loaded for every test client; without the frozen cache (CI) there are no bars
        assert body["last_bar_date"] is not None


def test_engine_git_sha_prefers_baked_env(monkeypatch):
    from engine.health import engine_git_sha
    monkeypatch.setenv("ENGINE_GIT_SHA", "abc1234")
    assert engine_git_sha() == "abc1234"


def test_engine_git_sha_falls_back_to_git_when_env_unset_or_unknown(monkeypatch):
    from types import SimpleNamespace
    from engine import health
    monkeypatch.setattr(health.subprocess, "run", lambda *a, **k: SimpleNamespace(stdout="fromgit\n"))
    monkeypatch.delenv("ENGINE_GIT_SHA", raising=False)
    assert health.engine_git_sha() == "fromgit"
    monkeypatch.setenv("ENGINE_GIT_SHA", "unknown")
    assert health.engine_git_sha() == "fromgit"
