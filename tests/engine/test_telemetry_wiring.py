"""The engine's instrumentation: data.fetch at the resolver choke point, screen.filter around a screen run, run binding from headers."""
from __future__ import annotations

from datetime import date

import pandas as pd
from fastapi.testclient import TestClient
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from engine.app import create_app
from engine.resolution.resolver import DataResolver
from engine.resolution.types import DataRequest, DataType, ProviderError, ProviderResult
from src import telemetry as tm
from tests.engine.v5_fixtures import literal_program

RUN = "44444444-4444-4444-4444-444444444444"


class FakeWriter:
    def __init__(self): self.rows = []
    def add(self, table, row): self.rows.append((table, row))
    def close(self, timeout=0): pass


def setup():
    spans, reader, w = InMemorySpanExporter(), InMemoryMetricReader(), FakeWriter()
    tp = TracerProvider(); tp.add_span_processor(SimpleSpanProcessor(spans))
    mp = MeterProvider(metric_readers=[reader])
    tm.configure(tracer=tp.get_tracer("t"), meter=mp.get_meter("t"), writer=w, tracer_provider=tp, meter_provider=mp)
    return spans, reader, w


class Fake:
    data_type = DataType.UNIVERSE
    def __init__(self, name, result=None, exc=None): self.name, self._r, self._e, self.primary = name, result, exc, False
    def fetch(self, request):
        if self._e: raise self._e
        return self._r


REQ = DataRequest(DataType.UNIVERSE, date(2026, 10, 5), key="NIFTY 100")


def resolver(*chain):
    r = DataResolver(config={"providers": {"timeout_s": 1, "retries": 0, "backoff_s": 0}}, sleep=lambda s: None)
    r.register(DataType.UNIVERSE, list(chain)); return r


def test_data_fetch_rows_for_ok_failed_and_routinely_unavailable_providers():
    spans, reader, w = setup()
    try:
        with tm.bind_run(RUN):
            resolver(Fake("down", exc=ProviderError("not here")), Fake("flaky", exc=ValueError("boom")), Fake("good", ProviderResult(["A", "B"], date(2026, 10, 5)))).resolve(REQ)
        rows = {r["tool_args"]["source"]: r for t, r in w.rows if t == "tool_calls"}
        assert (rows["down"]["status"], rows["flaky"]["status"], rows["good"]["status"]) == ("skipped", "error", "ok")
        assert rows["good"]["tool_name"] == "data.fetch" and rows["good"]["rows_out"] == 2
        data = reader.get_metrics_data()
        names = {m.name: m for rm in data.resource_metrics for sm in rm.scope_metrics for m in sm.metrics}
        errors = names["data_fetch.errors"].data.data_points
        assert {p.attributes["source"] for p in errors} == {"flaky"}                  # a routinely-unavailable provider is not an error
        assert all(set(p.attributes) == {"source", "symbol_bucket"} for p in errors)
    finally:
        tm.reset()


def test_resolver_behaviour_is_unchanged_when_telemetry_is_off():
    tm.reset()
    out = resolver(Fake("down", exc=ProviderError("x")), Fake("good", ProviderResult(["A"], date(2026, 10, 5)))).resolve(REQ)
    assert out.source == "good"


def test_screen_endpoint_records_screen_filter_with_rows_and_joins_the_callers_run(literal_env):
    spans, reader, w = setup()
    try:
        client = TestClient(create_app(offline=True))
        days = sorted({pd.Timestamp(d) for p in literal_env.panels.values() for d in p["date"]})
        tp = "00-" + "ef" * 16 + "-" + "12" * 8 + "-01"
        r = client.post("/screen", json={"program": literal_program(), "as_of": str(days[-10].date())}, headers={"traceparent": tp, "x-run-id": RUN, "x-prompt-id": "3"})
        assert r.status_code == 200
        row = next(r_ for t, r_ in w.rows if t == "tool_calls" and r_["tool_name"] == "screen.filter")
        assert row["run_id"] == RUN and row["trace_id"] == "ef" * 16 and row["rows_in"] is not None and row["rows_out"] is not None
        assert row["tool_args"]["as_of"] == str(days[-10].date())
        client.get("/health")
    finally:
        tm.reset()


def test_screen_endpoint_without_telemetry_or_headers_writes_nothing(client, literal_env):
    tm.reset()
    days = sorted({pd.Timestamp(d) for p in literal_env.panels.values() for d in p["date"]})
    assert client.post("/screen", json={"program": literal_program(), "as_of": str(days[-10].date())}).status_code == 200
