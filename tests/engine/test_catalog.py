from engine.conditions.catalog import catalog_payload


def test_catalog_has_the_four_v32_condition_types():
    names = {(e["kind"], e["name"]) for e in catalog_payload()}
    assert names == {
        ("field", "mcap_cr"),
        ("field", "traded_value_cr"),
        ("indicator", "vstop"),
        ("indicator", "rsi"),
    }


def test_catalog_never_carries_a_default_value():
    import json
    payload = catalog_payload()
    dumped = json.dumps(payload)
    assert '"default"' not in dumped


def test_vstop_catalog_entry_requires_length_mult_source():
    entry = next(e for e in catalog_payload() if e["name"] == "vstop")
    required = {p["name"] for p in entry["required_params"]}
    assert required == {"length", "mult", "source"}
    ops = {o["op"] for o in entry["ops"]}
    assert ops == {"flip"}


def test_get_conditions_endpoint(client):
    resp = client.get("/conditions")
    assert resp.status_code == 200
    assert len(resp.json()) == 4
