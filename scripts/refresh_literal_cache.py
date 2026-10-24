"""Refresh data_cache_literal/'s weekly bars to the latest Yahoo data (CLI twin of the app's "Refresh data" button).

bootstrap_literal.py only fetches tickers that are NOT cached, so it cannot refresh a stale cache. This rebuilds the
weekly panel for every cached ticker in chunks into a temp dir, then swaps it in (old files kept as *.bak) only if
>= 95% of tickers came back — see engine/refresh.py. A running engine keeps its data in memory: restart it, or use the
app's button, which also reloads it.

    .venv/bin/python -u scripts/refresh_literal_cache.py [--chunk 60] [--pause 6]
Needs network. The newest bar is the in-progress week until Friday's close.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine.refresh import RefreshState, last_refreshed, run_refresh  # noqa: E402
from src.config import load_rule_spec  # noqa: E402
from src.data.adapter import build_adapter  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--chunk", type=int, default=60)
    ap.add_argument("--pause", type=float, default=6.0)
    args = ap.parse_args()
    spec = load_rule_spec("config/rules_literal.yaml")
    cache_dir, weeks = Path(spec["data"]["cache_dir"]), spec["data"]["history_weeks"]
    state = RefreshState()
    ok = run_refresh(build_adapter(spec), cache_dir, weeks, state, chunk=args.chunk, pause=args.pause)
    snap = state.snapshot()
    print(f"{'done' if ok else 'FAILED'}: {snap['done']}/{snap['total']} tickers" + (f" — {snap['error']}" if snap["error"] else "") + f"; now {last_refreshed(cache_dir, weeks)}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
