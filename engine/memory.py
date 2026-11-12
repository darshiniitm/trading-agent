"""Process memory: what the engine reports in /health, and handing freed memory back to the OS after a (re)load.

The engine runs on a 2 GB VM (deploy/swarm/stack.yml caps it at 1600M). pandas frees a reload's old panels, but glibc
keeps the pages in its arenas unless asked to trim them, so a refresh would otherwise ratchet RSS up each time.
"""
from __future__ import annotations

import ctypes
import gc
import resource
import sys


def _proc_status_kb(field: str) -> int | None:
    try:
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith(field + ":"):
                    return int(line.split()[1])
    except OSError:
        return None
    return None


def usage_mb() -> dict:
    """Current and peak resident memory in MB. Linux reads /proc (both); elsewhere only the peak is known."""
    rss_kb, hwm_kb = _proc_status_kb("VmRSS"), _proc_status_kb("VmHWM")
    if hwm_kb is None:
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        hwm_kb = peak // 1024 if sys.platform == "darwin" else peak   # macOS reports bytes, Linux KB
    return {"rss_mb": round(rss_kb / 1024, 1) if rss_kb is not None else None, "peak_mb": round(hwm_kb / 1024, 1)}


def release() -> None:
    """Collect garbage, then return free heap pages to the OS (glibc only; a no-op elsewhere)."""
    gc.collect()
    if sys.platform.startswith("linux"):
        try:
            ctypes.CDLL("libc.so.6").malloc_trim(0)
        except (OSError, AttributeError):
            pass
