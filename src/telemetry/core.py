"""Engine-side observability: @task / @agent / @tool (and `tool_span`) over OpenTelemetry, structured start/end log lines,
metrics, and run-record rows — the Python twin of web/src/server/telemetry. A no-op until configure()/init() runs, so engine
tests and the weekly scripts behave exactly as before when nothing is configured.

Run context: the TS app sends `traceparent` (FastAPI instrumentation turns it into the parent span) and `x-run-id`
(RunHeaderMiddleware binds it). Rows are written only while a run is bound; spans and metrics are recorded regardless.
"""
from __future__ import annotations

import contextvars
import functools
import inspect
import json
import logging
import os
import uuid
import zlib
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from typing import Any, Callable

from opentelemetry import context as otel_context
from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode

from . import otlp
from .redact import MAX_FIELD_CHARS, redact_string, redact_value, truncate
from .writer import RunWriter

PG_FIELD_CAP = 1024 * 1024
log = logging.getLogger("telemetry.events")
_GEN_AI_OP = {"agent": "invoke_agent", "tool": "execute_tool"}


@dataclass
class RunCtx:
    run_id: str
    prompt_id: int | None = None
    counter: list = field(default_factory=lambda: [0])
    task_id: str | None = None
    task_name: str | None = None
    seq: int | None = None
    task_span_id: str | None = None
    agent_name: str | None = None
    agent_version: str | None = None
    agent_span_id: str | None = None


@dataclass
class Node:
    status: str = "ok"
    rows_in: int | None = None
    rows_out: int | None = None
    model: str | None = None
    provider: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    gpu_ms: int | None = None
    tool_args: Any = None
    error: tuple[str, str] | None = None
    attrs: dict = field(default_factory=dict)
    output: Any = None


class _State:
    enabled = False
    tracer = None
    inst: dict = {}
    writer: RunWriter | None = None
    stdout = False
    providers: list = []
    tracer_provider = None
    meter_provider = None


S = _State()
_RUN: contextvars.ContextVar[RunCtx | None] = contextvars.ContextVar("telemetry_run", default=None)
_NODE: contextvars.ContextVar[Node | None] = contextvars.ContextVar("telemetry_node", default=None)


def current_run() -> RunCtx | None:
    return _RUN.get()


def annotate(**kw) -> None:
    """Merge details into the span currently executing (rows_in/rows_out, status="fallback", model, tokens, ...)."""
    n = _NODE.get()
    if n is None:
        return
    for k, v in kw.items():
        if k == "attrs":
            n.attrs.update(v)
        elif hasattr(n, k):
            setattr(n, k, v)


def symbol_bucket(symbol: str, buckets: int = 16) -> str:
    """Bounded label for per-symbol data: the universe is ~2300 tickers, so a raw symbol label would explode cardinality."""
    return "b%02d" % (zlib.crc32(str(symbol).encode()) % buckets)


# ---- configuration -------------------------------------------------------------------------------------------------
def configure(*, tracer=None, meter=None, writer: RunWriter | None = None, stdout: bool = False, tracer_provider=None, meter_provider=None) -> None:
    S.tracer, S.writer, S.stdout = tracer, writer, stdout
    # kept so FastAPIInstrumentor uses OUR providers: it otherwise reads the (unset) global one and server spans are never exported
    S.tracer_provider, S.meter_provider = tracer_provider, meter_provider
    S.inst = {}
    if meter is not None:
        S.inst = {
            "task_duration": meter.create_histogram("task.duration", unit="s"),
            "agent_invocations": meter.create_counter("agent.invocations"),
            "agent_duration": meter.create_histogram("agent.duration", unit="s"),
            "tool_calls": meter.create_counter("tool.calls"),
            "tool_duration": meter.create_histogram("tool.duration", unit="s"),
            "fetch_errors": meter.create_counter("data_fetch.errors"),
            "fetch_symbols": meter.create_counter("data_fetch.symbols"),
        }
    S.enabled = bool(tracer or meter or writer)


def reset() -> None:
    w = S.writer
    S.enabled, S.tracer, S.inst, S.writer, S.stdout = False, None, {}, None, False
    S.tracer_provider = S.meter_provider = None
    if w is not None:
        try:
            w.close(1.0)
        except Exception:                                               # noqa: BLE001
            pass


def init(service_name: str | None = None, env=None) -> bool:
    """Env-driven setup (OTEL_EXPORTER_OTLP_ENDPOINT and/or TELEMETRY_DB_URL | SUPABASE_DB_URL). False = nothing configured."""
    env = os.environ if env is None else env
    if S.enabled:
        return True
    use_otlp = otlp.configured(env)
    dsn = env.get("TELEMETRY_DB_URL") or env.get("SUPABASE_DB_URL")
    if env.get("TELEMETRY_DISABLED") == "1" or not (use_otlp or dsn):
        return False
    service = service_name or env.get("OTEL_SERVICE_NAME") or "prompt-screener-engine"
    tracer = meter = None
    if use_otlp:
        hdrs = otlp.headers_from(env) or None
        from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
        from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
        from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
        from opentelemetry.sdk.metrics import MeterProvider
        from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        res = Resource.create({"service.name": service})
        tp = TracerProvider(resource=res)
        tp.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=otlp.endpoint_for(env, "traces"), headers=hdrs)))
        mp = MeterProvider(resource=res, metric_readers=[PeriodicExportingMetricReader(OTLPMetricExporter(endpoint=otlp.endpoint_for(env, "metrics"), headers=hdrs), export_interval_millis=15000)])
        lp = LoggerProvider(resource=res)
        lp.add_log_record_processor(BatchLogRecordProcessor(OTLPLogExporter(endpoint=otlp.endpoint_for(env, "logs"), headers=hdrs)))
        log.addHandler(LoggingHandler(logger_provider=lp))
        log.setLevel(logging.INFO)
        tracer, meter = tp.get_tracer(service), mp.get_meter(service)
        S.providers = [tp, mp, lp]
    configure(tracer=tracer, meter=meter, writer=RunWriter(dsn) if dsn else None, stdout=env.get("TELEMETRY_STDOUT_LOGS") == "1",
              tracer_provider=S.providers[0] if S.providers else None, meter_provider=S.providers[1] if S.providers else None)
    if S.stdout and not any(isinstance(h, logging.StreamHandler) and getattr(h, "_telemetry", False) for h in log.handlers):
        h = logging.StreamHandler()
        h._telemetry = True                                              # type: ignore[attr-defined]
        h.setFormatter(logging.Formatter("%(message)s"))
        log.addHandler(h)
        log.setLevel(logging.INFO)
    return True


def shutdown() -> None:
    for p in S.providers:
        try:
            p.shutdown()
        except Exception:                                               # noqa: BLE001
            pass
    S.providers = []
    if S.writer is not None:
        S.writer.close()


# ---- spans ---------------------------------------------------------------------------------------------------------------
def _capture(v):
    if v is None:
        return None
    value = redact_value(v)
    try:
        text = json.dumps(value, default=str)
    except Exception:                                                   # noqa: BLE001
        text = redact_string(str(v))
    short, trunc = truncate(text, MAX_FIELD_CHARS)
    if len(text) > PG_FIELD_CAP:
        return {"_truncated": text[:PG_FIELD_CAP]}, short, trunc, True
    return value, short, trunc, False


def _hex(n: int, w: int) -> str:
    return format(n, f"0{w}x")


class _Scope:
    def __init__(self, kind: str, name: str, *, span_name: str | None = None, args: Any = None, input_value: Any = None, version_of: str | None = None):
        self.kind, self.name, self.span_name = kind, name, span_name or name
        self.node = Node(tool_args=redact_value(args) if args is not None else None)
        self._input, self._version_of = input_value, version_of

    # convenience for `with tool_span(...) as sp:`
    def rows(self, rows_in=None, rows_out=None):
        self.node.rows_in, self.node.rows_out = rows_in, rows_out

    def status(self, status: str, message: str | None = None):
        self.node.status = status
        if message:
            self.node.error = ("Error", redact_string(message)[:2000])

    def set_output(self, v):
        self.node.output = v

    def __enter__(self):
        self._t0 = datetime.now(timezone.utc)
        self.run = _RUN.get()
        self.child = self.run
        if self.run is not None:
            self.child = replace(self.run)
            if self.kind == "task":
                self.run.counter[0] += 1
                self.child.task_id, self.child.task_name, self.child.seq = str(uuid.uuid4()), self.name, self.run.counter[0]
                self.child.agent_name = self.child.agent_version = self.child.agent_span_id = None
            elif self.kind == "agent":
                self.child.agent_name = self.name
                self.child.agent_version = _version(self._version_of)
        attrs = {"telemetry.kind": self.kind}
        if self.kind in _GEN_AI_OP:
            attrs["gen_ai.operation.name"] = _GEN_AI_OP[self.kind]
        attrs[{"agent": "gen_ai.agent.name", "tool": "gen_ai.tool.name", "task": "task.name"}[self.kind]] = self.name
        if self.run is not None:
            attrs["run.id"] = self.run.run_id
        self.parent_span_id = None
        cur = trace.get_current_span().get_span_context()
        if cur.is_valid:
            self.parent_span_id = _hex(cur.span_id, 16)
        self.span = S.tracer.start_span(self.span_name, attributes=attrs) if S.tracer else None
        sc = self.span.get_span_context() if self.span else None
        self.span_id = _hex(sc.span_id, 16) if sc else uuid.uuid4().hex[:16]
        self.trace_id = _hex(sc.trace_id, 32) if sc else (_hex(cur.trace_id, 32) if cur.is_valid else "")
        if self.child is not None:
            if self.kind == "task":
                self.child.task_span_id = self.span_id
            elif self.kind == "agent":
                self.child.agent_span_id = self.span_id
        self._tokens = []
        if self.span is not None:
            self._tokens.append(otel_context.attach(trace.set_span_in_context(self.span)))
        self._run_token = _RUN.set(self.child) if self.child is not None else None
        self._node_token = _NODE.set(self.node)
        self._inp = _capture(self._input) if self._input is not None else None
        self._emit("start", INFO=True, input=self._inp[1] if self._inp else None)
        return self

    def __exit__(self, et, ev, tb):
        try:
            self._finish(et, ev)
        except Exception:                                               # noqa: BLE001
            pass
        finally:
            _NODE.reset(self._node_token)
            if self._run_token is not None:
                _RUN.reset(self._run_token)
            for t in reversed(self._tokens):
                try:
                    otel_context.detach(t)
                except Exception:                                       # noqa: BLE001
                    pass
        return False

    def _emit(self, event: str, INFO=True, **extra):
        c = self.child
        fields = {
            "event": event, "kind": self.kind, "run_id": c.run_id if c else None, "prompt_id": c.prompt_id if c else None,
            "trace_id": self.trace_id, "span_id": self.span_id, "parent_span_id": self.parent_span_id,
            "task_id": c.task_id if c else None, "task_name": c.task_name if c else None, "seq": c.seq if c else None,
            "agent_name": (self.name if self.kind == "agent" else c.agent_name) if c else None,
            "agent_version": c.agent_version if c else None, **({"tool_name": self.name} if self.kind == "tool" else {}), **extra,
        }
        fields = {k: v for k, v in fields.items() if v is not None}
        try:
            log.log(logging.INFO if INFO else logging.ERROR, json.dumps({"msg": f"{self.kind}.{event} {self.name}", **fields}, default=str) if S.stdout else f"{self.kind}.{event} {self.name}", extra=_flat(fields))
        except Exception:                                               # noqa: BLE001
            pass

    def _finish(self, et, ev):
        t1 = datetime.now(timezone.utc)
        ms = int((t1 - self._t0).total_seconds() * 1000)
        n, failed = self.node, et is not None
        status = "error" if failed else n.status
        etype = et.__name__ if failed else (n.error[0] if n.error else None)
        emsg = redact_string(str(ev))[:2000] if failed else (n.error[1] if n.error else None)
        out = None if failed else _capture(n.output)
        if self.span is not None:
            for k, v in n.attrs.items():
                self.span.set_attribute(k, v)
            if n.rows_in is not None:
                self.span.set_attribute("rows.in", n.rows_in)
            if n.rows_out is not None:
                self.span.set_attribute("rows.out", n.rows_out)
            if failed:
                self.span.record_exception(ev)
                self.span.set_status(Status(StatusCode.ERROR, emsg))
            self.span.set_attribute("telemetry.status", status)
            self.span.end()
        secs, inst = ms / 1000, S.inst
        if inst:
            if self.kind == "task":
                inst["task_duration"].record(secs, {"task": self.name, "status": status})
            elif self.kind == "agent":
                inst["agent_invocations"].add(1, {"agent": self.name, "status": status}); inst["agent_duration"].record(secs, {"agent": self.name})
            else:
                inst["tool_calls"].add(1, {"tool": self.name, "status": status}); inst["tool_duration"].record(secs, {"tool": self.name})
        self._emit("end", INFO=not failed, status=status, error_type=etype, error_msg=emsg, started_at=self._t0.isoformat(), ended_at=t1.isoformat(),
                   duration_ms=ms, output=out[1] if out else None, rows_in=n.rows_in, rows_out=n.rows_out, model=n.model, provider=n.provider,
                   input_tokens=n.input_tokens, output_tokens=n.output_tokens, gpu_ms=n.gpu_ms, truncated=True if (out and out[2]) else None)
        if S.writer is None or self.run is None:
            return
        base = {"run_id": self.run.run_id, "trace_id": self.trace_id, "span_id": self.span_id, "parent_span_id": self.parent_span_id, "status": status,
                "started_at": self._t0.isoformat(), "ended_at": t1.isoformat(), "duration_ms": ms,
                "input": self._inp[0] if self._inp else None, "output": out[0] if out else None,
                "truncated": bool((self._inp and self._inp[3]) or (out and out[3])), "error_type": etype, "error_msg": emsg}
        if self.kind == "tool":
            S.writer.add("tool_calls", {**base, "agent_span_id": self.child.agent_span_id if self.child else None, "tool_name": self.name, "tool_args": n.tool_args,
                                        "rows_in": n.rows_in, "rows_out": n.rows_out, "model": n.model, "provider": n.provider, "input_tokens": n.input_tokens,
                                        "output_tokens": n.output_tokens, "gpu_ms": n.gpu_ms})
        elif self.kind == "agent":
            S.writer.add("agent_calls", {**base, "task_span_id": self.child.task_span_id if self.child else None, "agent_name": self.name,
                                         "agent_version": self.child.agent_version if self.child else None, "model": n.model, "provider": n.provider,
                                         "input_tokens": n.input_tokens, "output_tokens": n.output_tokens, "gpu_ms": n.gpu_ms})
        else:
            S.writer.add("run_tasks", {**base, "task_id": self.child.task_id if self.child else "", "task_name": self.name,
                                       "seq": self.child.seq if self.child else 0, "rows_in": n.rows_in, "rows_out": n.rows_out})


def _version(text: str | None) -> str | None:
    import hashlib
    return hashlib.sha256(text.encode()).hexdigest()[:12] if text else None


def _flat(fields: dict) -> dict:
    return {k: (v if isinstance(v, (str, int, float, bool)) else json.dumps(v, default=str)) for k, v in fields.items()}


@contextmanager
def tool_span(name: str, *, args=None, kind: str = "tool", span_name: str | None = None):
    """`with tool_span("data.fetch", args={...}) as sp:` — for code that signals failure by return value rather than raising."""
    if not S.enabled:
        yield _NullScope()
        return
    sc = _Scope(kind, name, span_name=span_name, args=args)
    with sc:
        yield sc


class _NullScope:
    def rows(self, *a, **k): pass
    def status(self, *a, **k): pass
    def set_output(self, *a, **k): pass


def _decorator(kind: str, name: str, *, span_name=None, args_of: Callable | None = None, rows_of: Callable | None = None, version_of: str | None = None,
               capture_input: bool = False, capture_output: bool = False):
    def deco(fn):
        def start(a, kw):
            args = None
            if args_of is not None:
                try:
                    args = args_of(*a, **kw)
                except Exception:                                       # noqa: BLE001
                    args = None
            return _Scope(kind, name, span_name=span_name, args=args, version_of=version_of, input_value=({"args": a, "kwargs": kw} if capture_input else None))

        def done(sc, out):
            if capture_output:
                sc.set_output(out)
            if rows_of is not None:
                try:
                    sc.rows(*rows_of(out))
                except Exception:                                       # noqa: BLE001
                    pass

        if inspect.iscoroutinefunction(fn):
            @functools.wraps(fn)
            async def awrapper(*a, **kw):
                if not S.enabled:
                    return await fn(*a, **kw)
                with start(a, kw) as sc:
                    out = await fn(*a, **kw)
                    done(sc, out)
                    return out
            return awrapper

        @functools.wraps(fn)
        def wrapper(*a, **kw):
            if not S.enabled:
                return fn(*a, **kw)
            with start(a, kw) as sc:
                out = fn(*a, **kw)
                done(sc, out)
                return out
        return wrapper
    return deco


def task(name: str, **kw):
    return _decorator("task", name, **kw)


def agent(name: str, **kw):
    return _decorator("agent", name, **kw)


def tool(name: str, **kw):
    return _decorator("tool", name, **kw)


# ---- run binding / threads ------------------------------------------------------------------------------------------------
@contextmanager
def bind_run(run_id: str, prompt_id: int | None = None):
    tok = _RUN.set(RunCtx(run_id=run_id, prompt_id=prompt_id))
    try:
        yield
    finally:
        _RUN.reset(tok)


def ctx_submit(pool, fn, *args, **kwargs):
    """ThreadPoolExecutor.submit that carries the OTel + run context into the worker thread (threads do not inherit contextvars)."""
    ctx = contextvars.copy_context()
    return pool.submit(ctx.run, fn, *args, **kwargs)


def count_fetch(source: str, symbols, failed: bool) -> None:
    """data_fetch_symbols_total{source} and, on failure, data_fetch_errors_total{source,symbol_bucket} (bounded buckets, never a symbol)."""
    inst = S.inst
    if not inst:
        return
    syms = list(symbols or [])
    inst["fetch_symbols"].add(len(syms) or 1, {"source": source})
    if failed:
        buckets: dict[str, int] = {}
        for s in syms or ["?"]:
            b = symbol_bucket(s)
            buckets[b] = buckets.get(b, 0) + 1
        for b, n in buckets.items():
            inst["fetch_errors"].add(n, {"source": source, "symbol_bucket": b})
