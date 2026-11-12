"""Exit when the process that started the engine is gone.

The web app starts the engine as a child and passes its own PID in ENGINE_PARENT_PID. A normal child-process cleanup
handler can't run when the app is killed with SIGKILL (or crashes hard), which would leave an orphan engine holding
the port and ~GBs of market data. This daemon thread polls the parent and shuts the engine down when it disappears.
Without ENGINE_PARENT_PID (an engine you start by hand, or ENGINE_MANAGED=0) it does nothing.
"""
from __future__ import annotations

import os
import signal
import subprocess
import threading
import time
from typing import Callable


def _is_zombie(pid: int) -> bool:
    """Killed but not yet reaped by its own parent: kill(pid, 0) still succeeds, but it is gone for our purposes."""
    try:
        out = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True, timeout=2).stdout
    except Exception:
        return False
    return out.strip().startswith("Z")


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:   # exists, owned by someone else
        return True
    return not _is_zombie(pid)


def watch(parent_pid: int, interval: float = 2.0, grace: float = 3.0, on_gone: Callable[[], None] | None = None) -> threading.Thread:
    def run() -> None:
        while pid_alive(parent_pid):
            time.sleep(interval)
        if on_gone:
            on_gone()
            return
        os.kill(os.getpid(), signal.SIGTERM)   # let uvicorn shut down cleanly...
        time.sleep(grace)
        os._exit(0)                            # ...and make sure it does

    t = threading.Thread(target=run, name="engine-parent-watchdog", daemon=True)
    t.start()
    return t


def start_from_env(env: dict | None = None, **kw) -> threading.Thread | None:
    raw = (env if env is not None else os.environ).get("ENGINE_PARENT_PID", "").strip()
    if not raw.isdigit() or int(raw) <= 1:
        return None
    interval = float((env if env is not None else os.environ).get("ENGINE_WATCHDOG_INTERVAL", "2"))
    return watch(int(raw), **{"interval": interval, **kw})
