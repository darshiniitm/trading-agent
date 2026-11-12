"""observability.cloud check: scripted version of Grafana's wizard curl. Tested against a fake session; it must never print a token."""
from __future__ import annotations

import base64

import pytest

from observability import cloud

INST, TOK, SA = "123456", "glc_OTLP_SECRET_TOKEN", "glsa_SA_SECRET_TOKEN"
B64 = base64.b64encode(f"{INST}:{TOK}".encode()).decode()
ENV = {"OTEL_EXPORTER_OTLP_ENDPOINT": "https://otlp-gateway-prod-eu-west-0.grafana.net/otlp", "GRAFANA_OTLP_INSTANCE_ID": INST, "GRAFANA_OTLP_TOKEN": TOK,
       "GRAFANA_URL": "https://acme.grafana.net", "GRAFANA_SA_TOKEN": SA}


class Resp:
    def __init__(self, code): self.status_code, self.text = code, ""


class Fake:
    """status: {url-suffix: code}; anything not listed returns 200. A value of 'boom' raises."""
    def __init__(self, status=None): self.status, self.calls = status or {}, []

    def request(self, method, url, json=None, headers=None, timeout=None):
        self.calls.append((method, url, json, headers))
        for suffix, code in self.status.items():
            if url.endswith(suffix):
                if code == "boom":
                    raise ConnectionError(f"failed to reach {url} with {headers}")     # a message that would leak if we printed it
                return Resp(code)
        return Resp(200)


def run(status=None, env=ENV):
    f = Fake(status)
    return cloud.check_credentials(env, session=f), f


def test_all_good_checks_the_three_otlp_signals_and_the_service_account():
    results, f = run()
    assert [r.name for r in results] == ["OTLP traces", "OTLP metrics", "OTLP logs", "Grafana API (service account)"]
    assert all(r.ok for r in results) and all(r.status == 200 for r in results)
    posts = [(m, u) for m, u, *_ in f.calls if m == "POST"]
    assert posts == [("POST", f"{ENV['OTEL_EXPORTER_OTLP_ENDPOINT']}/v1/{s}") for s in ("traces", "metrics", "logs")]
    otlp_calls = [c for c in f.calls if c[0] == "POST"]
    assert all(c[2] == {} and c[3]["Authorization"] == "Basic " + B64 and c[3]["Content-Type"] == "application/json" for c in otlp_calls)
    api = next(c for c in f.calls if c[0] == "GET")
    assert api[1] == "https://acme.grafana.net/api/org" and api[3]["Authorization"] == "Bearer " + SA


@pytest.mark.parametrize("code,needle", [(401, "instance ID or token"), (403, "metrics:write"), (404, "/otlp"), (429, "rate"), (503, "server")])
def test_each_failure_status_gets_a_plain_english_cause(code, needle):
    results, _ = run({"/v1/metrics": code})
    bad = next(r for r in results if r.name == "OTLP metrics")
    assert not bad.ok and bad.status == code and needle in bad.verdict
    assert all(r.ok for r in results if r.name != "OTLP metrics")


def test_scope_hint_names_the_signal():
    results, _ = run({"/v1/logs": 403})
    assert "logs:write" in next(r for r in results if r.name == "OTLP logs").verdict


def test_an_unreachable_endpoint_is_reported_without_leaking_the_exception_text():
    results, _ = run({"/v1/traces": "boom"})
    r = results[0]
    assert not r.ok and r.status is None and "unreachable" in r.verdict and "ConnectionError" in r.verdict
    assert B64 not in r.verdict and TOK not in r.verdict


def test_the_grafana_api_token_has_its_own_verdicts():
    assert "invalid" in run({"/api/org": 401})[0][3].verdict
    assert "Admin" in run({"/api/org": 403})[0][3].verdict


def test_missing_settings_are_reported_as_skipped_not_guessed():
    results, f = run(env={})
    assert [r.name for r in results] == ["OTLP traces", "OTLP metrics", "OTLP logs", "Grafana API (service account)"]
    assert all(r.status is None and not r.ok and "not set" in r.verdict for r in results)
    assert f.calls == []
    partial, f2 = run(env={k: v for k, v in ENV.items() if k.startswith("GRAFANA_URL") or k == "GRAFANA_SA_TOKEN"})
    assert all("not set" in r.verdict for r in partial[:3]) and partial[3].ok


def test_no_report_line_ever_contains_a_secret_or_the_encoded_credential():
    results, _ = run({"/v1/traces": 401, "/v1/logs": 403, "/api/org": 401})
    text = "\n".join(cloud.format_check(results))
    for secret in (TOK, SA, B64, INST + ":" + TOK):
        assert secret not in text


def test_cli_exit_codes_and_output(capsys, monkeypatch):
    for k, v in ENV.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setattr(cloud, "_default_session", lambda: Fake({"/v1/traces": 401}))
    assert cloud.main(["check", "--env-file", "/nonexistent"]) == 1
    out = capsys.readouterr().out
    assert "OTLP traces" in out and "401" in out and TOK not in out and SA not in out and B64 not in out
    monkeypatch.setattr(cloud, "_default_session", lambda: Fake())
    assert cloud.main(["check", "--env-file", "/nonexistent"]) == 0
    for k in ENV:
        monkeypatch.delenv(k)
    assert cloud.main(["check", "--env-file", "/nonexistent"]) == 2


def test_check_can_use_the_ready_made_otlp_header_when_instance_id_and_token_are_not_separate():
    env = {"OTEL_EXPORTER_OTLP_ENDPOINT": ENV["OTEL_EXPORTER_OTLP_ENDPOINT"], "OTEL_EXPORTER_OTLP_HEADERS": f"Authorization=Basic%20{B64}"}
    results, f = run(env=env)
    assert [r.ok for r in results[:3]] == [True, True, True]
    assert all(c[3]["Authorization"] == "Basic " + B64 for c in f.calls if c[0] == "POST")


def test_separate_instance_id_and_token_win_over_the_header_and_missing_everything_names_both_options():
    env = {**ENV, "OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Basic%20SOMETHINGELSE"}
    _, f = run(env=env)
    assert all(c[3]["Authorization"] == "Basic " + B64 for c in f.calls if c[0] == "POST")
    results, _ = run(env={"OTEL_EXPORTER_OTLP_ENDPOINT": ENV["OTEL_EXPORTER_OTLP_ENDPOINT"]})
    assert "OTEL_EXPORTER_OTLP_HEADERS" in results[0].verdict and "GRAFANA_OTLP_INSTANCE_ID" in results[0].verdict


def test_cli_reads_the_repo_root_env_file_as_well_as_observability_env(tmp_path, monkeypatch, capsys):
    for k in list(ENV) + ["OTEL_EXPORTER_OTLP_HEADERS"]:
        monkeypatch.delenv(k, raising=False)
    root, obs = tmp_path / ".env", tmp_path / "obs.env"
    root.write_text(f"OTEL_EXPORTER_OTLP_ENDPOINT={ENV['OTEL_EXPORTER_OTLP_ENDPOINT']}\nOTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic%20{B64}\n")
    obs.write_text(f"GRAFANA_URL={ENV['GRAFANA_URL']}\nGRAFANA_SA_TOKEN={SA}\n")
    monkeypatch.setattr(cloud, "DEFAULT_ENV_FILES", [root, obs])
    monkeypatch.setattr(cloud, "_default_session", lambda: Fake())
    assert cloud.main(["check"]) == 0
    out = capsys.readouterr().out
    assert out.count("OK ") == 4 and B64 not in out and SA not in out


def test_a_gateway_host_with_no_region_is_caught_before_any_request_is_made():
    env = {**ENV, "OTEL_EXPORTER_OTLP_ENDPOINT": "https://otlp-gateway-.grafana.net/otlp"}
    results, f = run(env=env)
    assert all(not r.ok and r.status is None and "region" in r.verdict and "otlp-gateway-prod-" in r.verdict for r in results[:3])
    assert [c for c in f.calls if c[0] == "POST"] == []            # nothing sent to a host that cannot be right
    assert results[3].ok                                           # the Grafana API check is independent


def test_cloudflare_530_means_the_host_does_not_exist_not_try_again():
    results, _ = run({"/v1/traces": 530})
    assert "host" in results[0].verdict and "530" in results[0].verdict and "try again" not in results[0].verdict


@pytest.mark.parametrize("endpoint,flag", [("https://otlp-gateway-prod-eu-west-0.grafana.net/otlp", False), ("https://otlp-gateway-prod-us-central-0.grafana.net/otlp/", False),
                                           ("https://otlp-gateway-.grafana.net/otlp", True), ("https://otlp-gateway-prod-.grafana.net/otlp", True), ("https://otlp-gateway-REGION.grafana.net/otlp", True),
                                           ("http://localhost:4318", False)])
def test_endpoint_shape_detection(endpoint, flag):
    assert bool(cloud.endpoint_problem(endpoint)) is flag


def test_check_tolerates_a_stray_space_after_the_auth_scheme_like_the_app_does():
    env = {"OTEL_EXPORTER_OTLP_ENDPOINT": ENV["OTEL_EXPORTER_OTLP_ENDPOINT"], "OTEL_EXPORTER_OTLP_HEADERS": f"Authorization=Basic%20 {B64}"}
    results, f = run(env=env)
    assert all(r.ok for r in results[:3])
    assert all(c[3]["Authorization"] == "Basic " + B64 for c in f.calls if c[0] == "POST")


def test_a_401_with_a_malformed_header_points_at_the_header_not_just_the_credentials():
    env = {"OTEL_EXPORTER_OTLP_ENDPOINT": ENV["OTEL_EXPORTER_OTLP_ENDPOINT"], "OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Basic%20 "}
    results, _ = run({"/v1/traces": 401}, env=env)
    assert "OTEL_EXPORTER_OTLP_HEADERS" in results[0].verdict or "not set" in results[0].verdict
