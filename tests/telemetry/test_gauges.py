from opentelemetry.sdk.metrics.export import InMemoryMetricReader

from src.telemetry import otlp
from src.telemetry.gauges import push_gauges


def points(reader):
    data = reader.get_metrics_data()
    return {m.name: [(dict(p.attributes), p.value) for p in m.data.data_points] for rm in data.resource_metrics for sm in rm.scope_metrics for m in sm.metrics}


def test_headers_parse_like_the_otel_env_var_with_url_decoding():
    h = otlp.headers_from({"OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Basic%20QUJD,x-scope=a=b"})
    assert h == {"Authorization": "Basic QUJD", "x-scope": "a=b"}
    assert otlp.headers_from({}) == {}
    assert otlp.headers_from({"OTEL_EXPORTER_OTLP_HEADERS": "garbage, ,k="}) == {"k": ""}


def test_endpoint_per_signal_follows_the_otlp_http_convention():
    env = {"OTEL_EXPORTER_OTLP_ENDPOINT": "https://otlp-gateway-prod-eu-west-0.grafana.net/otlp/"}
    assert otlp.endpoint_for(env, "metrics") == "https://otlp-gateway-prod-eu-west-0.grafana.net/otlp/v1/metrics"
    assert otlp.endpoint_for({**env, "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT": "http://x/m"}, "metrics") == "http://x/m"


def test_gauges_are_recorded_with_their_labels_and_flushed():
    r = InMemoryMetricReader()
    ok = push_gauges([("screener_job_last_success_timestamp", {"screener_job": "weekly_select"}, 1.79e9), ("golden_suite_accuracy", {"provider": "cloud", "model": "m", "suite_version": "v1"}, 0.98)], reader=r)
    assert ok
    p = points(r)
    assert p["screener_job_last_success_timestamp"] == [({"screener_job": "weekly_select"}, 1.79e9)]
    assert p["golden_suite_accuracy"][0][1] == 0.98


def test_without_an_endpoint_it_does_nothing_and_never_raises():
    assert push_gauges([("x", {}, 1.0)], env={}) is False


def test_a_dead_collector_never_raises():
    assert push_gauges([("x", {}, 1.0)], env={"OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:9"}, timeout_s=1.0) in (True, False)


def test_a_stray_space_after_the_auth_scheme_is_tolerated():
    """`Authorization=Basic%20 <credential>` (a literal space after %20) decodes to two spaces, which Grafana rejects with 401."""
    h = otlp.headers_from({"OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Basic%20 QUJD,x-scope=a  b"})
    assert h["Authorization"] == "Basic QUJD"
    assert h["x-scope"] == "a  b"                      # only the auth scheme separator is normalised
    assert otlp.headers_from({"OTEL_EXPORTER_OTLP_HEADERS": "authorization=Bearer%20%20tok"})["authorization"] == "Bearer tok"
