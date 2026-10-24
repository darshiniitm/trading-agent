"""observability.cloud: plans (dry-run) and applies dashboards, alert rules, a Postgres datasource and a contact point to a Grafana Cloud
stack through its HTTP API. Tested against a fake session -- no stack is contacted."""
from __future__ import annotations

import base64
import json

import pytest

from observability import build as ob
from observability import cloud

ENV = {"GRAFANA_URL": "https://acme.grafana.net/", "GRAFANA_SA_TOKEN": "glsa_SECRET_TOKEN", "ALERT_WEBHOOK_URL": "https://hooks.example/alert",
       "GRAFANA_PG_HOST": "pooler.example:5432", "GRAFANA_PG_DATABASE": "postgres", "GRAFANA_PG_USER": "grafana_ro", "GRAFANA_PG_PASSWORD": "pw-SECRET",
       "LLM_WEEKLY_GPU_SECONDS_BUDGET": "5000"}

DATASOURCES = [
    {"uid": "grafanacloud-usage", "name": "grafanacloud-acme-usage", "type": "prometheus"},
    {"uid": "grafanacloud-prom", "name": "grafanacloud-acme-prom", "type": "prometheus", "isDefault": True},
    {"uid": "grafanacloud-logs", "name": "grafanacloud-acme-logs", "type": "loki"},
    {"uid": "grafanacloud-traces", "name": "grafanacloud-acme-traces", "type": "tempo"},
]


class Resp:
    def __init__(self, status=200, body=None):
        self.status_code, self._b = status, body if body is not None else {}
        self.text = json.dumps(self._b)
    def json(self): return self._b


class FakeSession:
    """Records every call; `state` decides what already exists on the stack."""
    def __init__(self, existing=()):
        self.calls, self.existing, self.headers = [], set(existing), {}

    def request(self, method, url, json=None, headers=None, timeout=None):
        path = url.split("grafana.net", 1)[1]
        self.calls.append((method, path, json, headers))
        if method == "GET" and path == "/api/datasources":
            return Resp(200, DATASOURCES)
        if method == "GET":
            return Resp(200, [{"name": "prompt-screener-webhook", "uid": "cp1"}] if path.endswith("contact-points") and "contact-point" in self.existing else {}) if (path.endswith("contact-points") or path in self.existing) else Resp(404, {"message": "not found"})
        return Resp(200, {"ok": True})


def mk(existing=(), **kw):
    s = FakeSession(existing)
    return cloud.GrafanaCloud(ENV["GRAFANA_URL"], ENV["GRAFANA_SA_TOKEN"], session=s, **kw), s


def writes(s):
    return [(m, p) for m, p, *_ in s.calls if m != "GET"]


def test_headers_helper_builds_the_basic_auth_value_from_instance_id_and_token():
    line = cloud.otlp_headers_line({"GRAFANA_OTLP_INSTANCE_ID": "123456", "GRAFANA_OTLP_TOKEN": "glc_tok"})
    assert line == "OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic%20" + base64.b64encode(b"123456:glc_tok").decode()
    with pytest.raises(SystemExit):
        cloud.otlp_headers_line({})


def test_discovery_picks_the_stacks_prometheus_loki_and_tempo_not_the_usage_datasource():
    g, _ = mk()
    assert g.discover_datasources() == {"prom": "grafanacloud-prom", "loki": "grafanacloud-logs", "tempo": "grafanacloud-traces"}


def test_dashboards_are_remapped_to_the_real_datasource_uids_including_inside_explore_links():
    mapping = {"prom": "grafanacloud-prom", "loki": "grafanacloud-logs", "tempo": "grafanacloud-traces"}
    for name, fn in ob.DASHBOARDS.items():
        out = json.dumps(cloud.remap_dashboard(fn().render(), mapping))
        assert '"uid": "prom"' not in out and '"uid": "loki"' not in out and '"uid": "tempo"' not in out, name
        assert "%22tempo%22" not in out and "%22loki%22" not in out, name
    d = json.dumps(cloud.remap_dashboard(ob.run_explorer().render(), mapping))
    assert "grafanacloud-traces" in d and "%22grafanacloud-traces%22" in d       # the trace link now points at the real Tempo
    assert '"uid": "supabase"' in d                                              # the Postgres datasource keeps its own uid


def test_alert_payloads_expand_the_budget_and_use_real_datasource_uids():
    p = {r["uid"]: r for r in cloud.alert_payloads({"prom": "grafanacloud-prom"}, folder_uid="prompt-screener", env=ENV)}
    assert len(p) == 10
    budget = p["ps-alert-cloud-budget"]["data"][0]["model"]["expr"]
    assert "5000" in budget and "${" not in budget
    assert all(r["data"][0]["datasourceUid"] == "grafanacloud-prom" and r["folderUID"] == "prompt-screener" and r["ruleGroup"] == "prompt-screener" for r in p.values())
    assert p["ps-alert-weekly-run-missed"]["noDataState"] == "Alerting" and p["ps-alert-llm-failing"]["noDataState"] == "OK"
    assert p["ps-alert-llm-failing"]["labels"]["severity"] == "page" and p["ps-alert-llm-failing"]["for"] == "10m"


def test_dry_run_sends_no_writes_and_never_includes_secrets_in_the_report():
    g, s = mk()
    report = g.sync(env=ENV, apply=False)
    assert writes(s) == []
    text = "\n".join(report)
    assert "glsa_SECRET_TOKEN" not in text and "pw-SECRET" not in text
    assert any("6 dashboards" in l for l in report) and any("10 alert rules" in l for l in report) and any("DRY RUN" in l for l in report)


def test_apply_creates_folder_datasource_dashboards_rules_and_contact_point_in_a_safe_order():
    g, s = mk()
    g.sync(env=ENV, apply=True)
    w = writes(s)
    order = [p for _, p in w]
    assert order.index("/api/folders") < order.index("/api/dashboards/db") < order.index("/api/v1/provisioning/alert-rules")
    assert sum(1 for _, p in w if p == "/api/dashboards/db") == 6
    assert sum(1 for m, p in w if m == "POST" and p == "/api/v1/provisioning/alert-rules") == 10
    assert ("POST", "/api/datasources") in w and ("POST", "/api/v1/provisioning/contact-points") in w
    assert "/api/v1/provisioning/policies" not in order                        # opt-in only: it replaces the stack's whole routing tree
    dash = next(b for m, p, b, h in s.calls if p == "/api/dashboards/db")
    assert dash["overwrite"] is True and dash["folderUid"] == "prompt-screener" and dash["dashboard"]["id"] is None
    ds = next(b for m, p, b, h in s.calls if (m, p) == ("POST", "/api/datasources"))
    assert ds["uid"] == "supabase" and ds["user"] == "grafana_ro" and ds["secureJsonData"]["password"] == "pw-SECRET" and ds["jsonData"]["sslmode"] == "require"
    rule_hdr = next(h for m, p, b, h in s.calls if (m, p) == ("POST", "/api/v1/provisioning/alert-rules"))
    assert rule_hdr["X-Disable-Provenance"] == "true"                          # rules stay editable in the UI
    auth = [h.get("Authorization") for _, _, _, h in s.calls if h]
    assert all(a == "Bearer glsa_SECRET_TOKEN" for a in auth if a)


def test_apply_is_idempotent_updating_what_exists_instead_of_duplicating():
    existing = {"/api/folders/prompt-screener", "/api/datasources/uid/supabase", "contact-point"} | {f"/api/v1/provisioning/alert-rules/{r['uid']}" for r in ob.RULES}
    g, s = mk(existing)
    g.sync(env=ENV, apply=True)
    w = writes(s)
    assert ("POST", "/api/folders") not in w and ("POST", "/api/datasources") not in w
    assert ("PUT", "/api/datasources/uid/supabase") in w
    assert sum(1 for m, p in w if m == "PUT" and p.startswith("/api/v1/provisioning/alert-rules/")) == 10
    assert not any(m == "POST" and p == "/api/v1/provisioning/alert-rules" for m, p in w)
    assert ("PUT", "/api/v1/provisioning/contact-points/cp1") in w


def test_policies_only_when_asked_and_postgres_can_be_skipped():
    g, s = mk()
    g.sync(env=ENV, apply=True, policies=True, postgres=False)
    w = writes(s)
    assert ("PUT", "/api/v1/provisioning/policies") in w and ("POST", "/api/datasources") not in w
    pol = next(b for m, p, b, h in s.calls if p == "/api/v1/provisioning/policies")
    assert pol["receiver"] == "prompt-screener-webhook" and pol["routes"][0]["object_matchers"] == [["severity", "=", "page"]]


def test_missing_postgres_credentials_skip_the_datasource_with_a_warning_instead_of_failing():
    g, s = mk()
    env = {k: v for k, v in ENV.items() if not k.startswith("GRAFANA_PG_")}
    report = g.sync(env=env, apply=True)
    assert ("POST", "/api/datasources") not in writes(s)
    assert any("Postgres" in l and "skipped" in l for l in report)


def test_an_api_error_stops_with_a_clear_message_that_has_no_secret_in_it():
    class Bad(FakeSession):
        def request(self, method, url, json=None, headers=None, timeout=None):
            if method == "POST" and url.endswith("/api/folders"):
                return Resp(403, {"message": "permission denied for token glsa_SECRET_TOKEN"})
            return super().request(method, url, json=json, headers=headers, timeout=timeout)
    g = cloud.GrafanaCloud(ENV["GRAFANA_URL"], ENV["GRAFANA_SA_TOKEN"], session=Bad())
    with pytest.raises(cloud.SyncError) as e:
        g.sync(env=ENV, apply=True)
    assert "403" in str(e.value) and "glsa_SECRET_TOKEN" not in str(e.value)


def test_cli_dry_run_without_credentials_still_prints_the_plan(capsys, monkeypatch):
    for k in ("GRAFANA_URL", "GRAFANA_SA_TOKEN"):
        monkeypatch.delenv(k, raising=False)
    assert cloud.main(["sync", "--env-file", "/nonexistent"]) == 0
    out = capsys.readouterr().out
    assert "DRY RUN" in out and "6 dashboards" in out and "offline" in out


def test_cli_apply_without_credentials_refuses(monkeypatch, capsys):
    for k in ("GRAFANA_URL", "GRAFANA_SA_TOKEN"):
        monkeypatch.delenv(k, raising=False)
    assert cloud.main(["sync", "--apply", "--env-file", "/nonexistent"]) == 2
