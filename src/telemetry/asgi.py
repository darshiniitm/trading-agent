"""FastAPI glue: bind the run id the TS app sends (`x-run-id`, `x-prompt-id`) and instrument the app (extracts `traceparent`)."""
from __future__ import annotations

from . import core


class RunHeaderMiddleware:
    """Pure ASGI: contextvars set here are copied into sync endpoints' worker threads by Starlette/anyio."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not core.S.enabled:
            return await self.app(scope, receive, send)
        headers = {k.lower(): v for k, v in scope.get("headers", [])}
        rid = headers.get(b"x-run-id")
        if not rid:
            return await self.app(scope, receive, send)
        pid = headers.get(b"x-prompt-id")
        with core.bind_run(rid.decode(), int(pid) if pid and pid.isdigit() else None):
            return await self.app(scope, receive, send)


def install_fastapi(app) -> None:
    """No-op unless telemetry is configured. Adds the run-header middleware, then the OTel server-span middleware outside it."""
    if not core.S.enabled:
        return
    app.add_middleware(RunHeaderMiddleware)
    try:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        FastAPIInstrumentor.instrument_app(app, tracer_provider=core.S.tracer_provider, meter_provider=core.S.meter_provider, excluded_urls="health,data/health")
    except Exception:                                                   # noqa: BLE001
        pass
