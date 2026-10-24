import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from opentelemetry import trace
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from src import telemetry as tm
from src.telemetry import core

RUN = "11111111-1111-1111-1111-111111111111"


class FakeWriter:
    def __init__(self):
        self.rows = []

    def add(self, table, row):
        self.rows.append((table, row))

    def close(self, timeout=0):
        pass


@pytest.fixture
def t():
    spans, reader, writer = InMemorySpanExporter(), InMemoryMetricReader(), FakeWriter()
    tp = TracerProvider()
    tp.add_span_processor(SimpleSpanProcessor(spans))
    mp = MeterProvider(metric_readers=[reader])
    tm.configure(tracer=tp.get_tracer("test"), meter=mp.get_meter("test"), writer=writer, tracer_provider=tp, meter_provider=mp)
    yield type("T", (), {"spans": spans, "reader": reader, "writer": writer})
    tm.reset()


def metric(reader, name):
    data = reader.get_metrics_data()
    out = []
    for rm in (data.resource_metrics if data else []):
        for sm in rm.scope_metrics:
            out += [m for m in sm.metrics if m.name == name]
    return out[0] if out else None


def test_disabled_is_a_pass_through():
    tm.reset()

    @tm.tool("x")
    def f(a):
        return a + 1

    @tm.tool("y")
    async def g(a):
        return a * 2

    assert f(1) == 2 and asyncio.run(g(4)) == 8
    with pytest.raises(ValueError):
        tm.tool("z")(lambda: (_ for _ in ()).throw(ValueError("boom")))()
    with tm.tool_span("x") as sp:
        sp.rows(1, 2)


def test_nesting_attributes_and_rows_only_inside_a_run(t):
    @tm.tool("price_fetch", args_of=lambda s: {"symbol": s}, rows_of=lambda out: (1, len(out)))
    def fetch(s):
        return [1, 2, 3]

    @tm.agent("reader", version_of="system prompt v1")
    def reader():
        return fetch("ABC")

    @tm.task("interpret")
    def interpret():
        return reader()

    with tm.bind_run(RUN, 7):
        interpret()
    spans = {s.name: s for s in t.spans.get_finished_spans()}
    assert set(spans) == {"price_fetch", "reader", "interpret"}
    assert spans["price_fetch"].parent.span_id == spans["reader"].context.span_id
    assert spans["reader"].parent.span_id == spans["interpret"].context.span_id
    assert spans["price_fetch"].attributes["gen_ai.operation.name"] == "execute_tool"
    assert spans["price_fetch"].attributes["rows.out"] == 3
    tables = {tb: r for tb, r in t.writer.rows}
    assert tables["tool_calls"]["agent_span_id"] == format(spans["reader"].context.span_id, "016x")
    assert tables["tool_calls"]["tool_args"] == {"symbol": "ABC"} and tables["tool_calls"]["rows_out"] == 3
    assert tables["agent_calls"]["task_span_id"] == format(spans["interpret"].context.span_id, "016x")
    assert len(tables["agent_calls"]["agent_version"]) == 12
    assert tables["run_tasks"]["seq"] == 1 and tables["run_tasks"]["run_id"] == RUN

    t.writer.rows.clear()
    fetch("ABC")                               # outside a run: span + metrics, no rows
    assert t.writer.rows == []
    assert metric(t.reader, "tool.calls") is not None


def test_errors_are_recorded_redacted_and_rethrown(t):
    @tm.tool("bad")
    def bad():
        raise RuntimeError("failed with Bearer abc123 for a@b.io")

    with tm.bind_run(RUN), pytest.raises(RuntimeError):
        bad()
    row = t.writer.rows[0][1]
    assert row["status"] == "error" and row["error_type"] == "RuntimeError"
    assert row["error_msg"] == "failed with Bearer [redacted] for [redacted-email]"
    assert t.spans.get_finished_spans()[0].status.status_code.name == "ERROR"


def test_tool_span_for_return_value_failures_and_annotate(t):
    with tm.bind_run(RUN):
        with tm.tool_span("data.fetch", args={"source": "yahoo"}) as sp:
            sp.rows(5, 0)
            sp.status("error", "empty")
        with tm.tool_span("screen") as sp2:
            tm.annotate(status="fallback", model="m", rows_in=9)
    a, b = [r for _, r in t.writer.rows]
    assert (a["status"], a["rows_in"], a["rows_out"], a["error_msg"]) == ("error", 5, 0, "empty")
    assert (b["status"], b["model"], b["rows_in"]) == ("fallback", "m", 9)


def test_ctx_submit_carries_the_span_and_run_into_worker_threads(t):
    seen = {}

    def work():
        seen["run"] = tm.current_run()
        with tm.tool_span("in_thread"):
            pass

    with ThreadPoolExecutor(1) as pool, tm.bind_run(RUN):
        with tm.tool_span("outer"):
            tm.ctx_submit(pool, work).result()
        # a plain submit would lose the context:
        lost = {}
        pool.submit(lambda: lost.setdefault("run", tm.current_run())).result()
    assert seen["run"].run_id == RUN and lost["run"] is None
    spans = {s.name: s for s in t.spans.get_finished_spans()}
    assert spans["in_thread"].parent.span_id == spans["outer"].context.span_id


def test_symbol_bucket_is_bounded_and_fetch_counters_never_label_a_symbol(t):
    assert len({tm.symbol_bucket(f"SYM{i}.NS") for i in range(2300)}) <= 16
    assert tm.symbol_bucket("ABC.NS") == tm.symbol_bucket("ABC.NS")
    tm.count_fetch("yahoo", [f"S{i}" for i in range(100)], failed=True)
    tm.count_fetch("yahoo", ["A", "B"], failed=False)
    errs = metric(t.reader, "data_fetch.errors").data.data_points
    assert sum(p.value for p in errs) == 100 and all(set(p.attributes) == {"source", "symbol_bucket"} for p in errs)
    assert len({p.attributes["symbol_bucket"] for p in errs}) <= 16
    assert sum(p.value for p in metric(t.reader, "data_fetch.symbols").data.data_points) == 102


def test_asgi_binds_the_run_header_and_parents_on_traceparent(t):
    app = FastAPI()
    seen = {}

    @app.get("/probe")
    def probe():
        seen["run"] = tm.current_run()
        with tm.tool_span("engine.probe"):
            pass
        return {"ok": True}

    tm.install_fastapi(app)
    tp = "00-" + "ab" * 16 + "-" + "cd" * 8 + "-01"
    with TestClient(app) as c:
        assert c.get("/probe", headers={"traceparent": tp, "x-run-id": RUN, "x-prompt-id": "7"}).status_code == 200
        c.get("/probe")                               # no header: no run bound
    assert seen["run"] is None                         # last request had no header
    row = next(r for tb, r in t.writer.rows if tb == "tool_calls")
    assert row["run_id"] == RUN and row["trace_id"] == "ab" * 16
    server = next(s for s in t.spans.get_finished_spans() if s.kind == trace.SpanKind.SERVER and format(s.context.trace_id, "032x") == "ab" * 16)
    assert format(server.parent.span_id, "016x") == "cd" * 8


def test_install_fastapi_is_a_no_op_when_disabled():
    tm.reset()
    app = FastAPI()
    before = len(app.user_middleware)
    tm.install_fastapi(app)
    assert len(app.user_middleware) == before
