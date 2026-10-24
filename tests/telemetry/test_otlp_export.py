"""init() against a fake OTLP/HTTP collector: the Authorization header Grafana Cloud needs is really sent, on every signal."""
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from src import telemetry as tm
from src.telemetry.gauges import push_gauges


class Collector(HTTPServer):
    def __init__(self):
        super().__init__(("127.0.0.1", 0), self.Handler)
        self.hits = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            n = int(self.headers.get("content-length", 0))
            self.rfile.read(n)
            self.server.hits.append((self.path, self.headers.get("authorization")))
            self.send_response(200); self.send_header("content-type", "application/x-protobuf"); self.end_headers()

        def log_message(self, *a):
            pass


def serve():
    c = Collector()
    threading.Thread(target=c.serve_forever, daemon=True).start()
    return c, f"http://127.0.0.1:{c.server_address[1]}"


def test_spans_metrics_and_logs_carry_the_basic_auth_header():
    c, url = serve()
    env = {"OTEL_EXPORTER_OTLP_ENDPOINT": url + "/otlp", "OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Basic%20aW5zdDp0b2s=", "OTEL_SERVICE_NAME": "svc-test"}
    try:
        assert tm.init("svc-test", env=env) is True
        with tm.bind_run("55555555-5555-5555-5555-555555555555"), tm.tool_span("demo"):
            pass
        tm.shutdown()
        paths = {p for p, _ in c.hits}
        assert {"/otlp/v1/traces", "/otlp/v1/metrics"} <= paths
        assert all(auth == "Basic aW5zdDp0b2s=" for _, auth in c.hits), c.hits
    finally:
        tm.reset(); c.shutdown()


def test_gauge_push_sends_the_header_too():
    c, url = serve()
    try:
        ok = push_gauges([("screener_job_last_success_timestamp", {"screener_job": "x"}, 1.0)],
                         env={"OTEL_EXPORTER_OTLP_ENDPOINT": url + "/otlp", "OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Basic%20Zm9v"})
        assert ok and ("/otlp/v1/metrics", "Basic Zm9v") in c.hits
    finally:
        c.shutdown()
