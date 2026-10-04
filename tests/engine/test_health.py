def test_health_returns_ok_and_git_sha(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert isinstance(body["engine_git_sha"], str) and len(body["engine_git_sha"]) > 0
    assert body["last_bar_date"] is not None  # offline env is now loaded for every test client
