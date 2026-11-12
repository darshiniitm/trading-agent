"""Batch gauges over OTLP, for short-lived processes (weekly jobs, eval scripts). Grafana Cloud has no Pushgateway, so the value is
recorded on a one-shot MeterProvider and flushed before exit.

A pushed series goes stale ~5 minutes after the process exits, so dashboards and alerts read these gauges with
`last_over_time(metric[30d])` (see observability/build.py), which keeps the last weekly value visible.
"""
from __future__ import annotations

import os
import sys

from . import otlp


def push_gauges(gauges: list[tuple[str, dict, float]], *, env=None, reader=None, service: str = "prompt-screener-jobs", timeout_s: float = 5.0) -> bool:
    """gauges: [(metric_name, {label: value}, value)]. Returns True if they were handed to an exporter. Never raises."""
    env = os.environ if env is None else env
    if reader is None and not otlp.configured(env):
        return False
    try:
        from opentelemetry.sdk.metrics import MeterProvider
        from opentelemetry.sdk.resources import Resource
        if reader is None:
            from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
            from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
            reader = PeriodicExportingMetricReader(OTLPMetricExporter(endpoint=otlp.endpoint_for(env, "metrics"), headers=otlp.headers_from(env) or None, timeout=timeout_s),
                                                   export_interval_millis=3_600_000)
        provider = MeterProvider(resource=Resource.create({"service.name": env.get("OTEL_SERVICE_NAME") or service}), metric_readers=[reader])
        meter = provider.get_meter(service)
        made = {}
        for name, labels, value in gauges:
            g = made.get(name) or made.setdefault(name, meter.create_gauge(name))
            g.set(float(value), labels)
        provider.force_flush(int(timeout_s * 1000))
        if hasattr(reader, "_exporter"):          # keep the in-memory test reader readable; real exporters are shut down
            provider.shutdown(int(timeout_s * 1000))
        return True
    except Exception as exc:                                             # noqa: BLE001 - batch metrics must never break a job
        print(f"gauges: push failed ({type(exc).__name__}: {exc})", file=sys.stderr)
        return False
