"""OTLP/HTTP connection settings, read from the env mapping it is given (not process.env) so tests and callers control it.

Grafana Cloud: OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-<zone>.grafana.net/otlp and
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic%20<base64(instanceId:token)>   (python -m observability.cloud headers builds it).
"""
from __future__ import annotations

import re
from urllib.parse import unquote


def configured(env) -> bool:
    return bool(env.get("OTEL_EXPORTER_OTLP_ENDPOINT") or env.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"))


def endpoint_for(env, signal: str) -> str:
    specific = env.get(f"OTEL_EXPORTER_OTLP_{signal.upper()}_ENDPOINT")
    return specific or f"{(env.get('OTEL_EXPORTER_OTLP_ENDPOINT') or '').rstrip('/')}/v1/{signal}"


def headers_from(env) -> dict[str, str]:
    """OTEL_EXPORTER_OTLP_HEADERS: comma-separated key=value, values URL-decoded (so `Basic%20abc` becomes `Basic abc`)."""
    out: dict[str, str] = {}
    for part in (env.get("OTEL_EXPORTER_OTLP_HEADERS") or "").split(","):
        if "=" not in part:
            continue
        k, v = part.split("=", 1)
        if k.strip():
            val = unquote(v.strip())
            if k.strip().lower() == "authorization":
                val = re.sub(r"^(\S+)\s+", r"\1 ", val)         # `Basic%20 <cred>` (stray space after %20) would be two spaces -> 401
            out[k.strip()] = val
    return out
