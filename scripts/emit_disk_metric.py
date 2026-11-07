"""Send root-disk usage as an OTLP gauge (screener_disk_used_ratio) -- replaces the host metrics an agent would have sent.
Run every 15 minutes by deploy/swarm/systemd/screener-disk.timer. Never raises; no-op without OTEL_EXPORTER_OTLP_ENDPOINT.
    python -m scripts.emit_disk_metric [--path /] [--dry-run]
"""
from __future__ import annotations

import argparse
import shutil
import sys


def disk_gauges(path: str = "/", usage=shutil.disk_usage):
    u = usage(path)
    return [("screener_disk_used_ratio", {"mount": path}, round(u.used / u.total, 4))]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--path", default="/")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    try:
        g = disk_gauges(a.path)
        if a.dry_run:
            print(g)
        else:
            from src.telemetry.gauges import push_gauges
            push_gauges(g, service="prompt-screener-host")
    except Exception as exc:  # noqa: BLE001
        print(f"emit_disk_metric: {type(exc).__name__}: {exc}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
