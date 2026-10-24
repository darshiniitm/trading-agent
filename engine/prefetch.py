"""Nightly prefetch: `python -m engine.prefetch [--force]`. Run after NSE close (default 20:00 IST) from cron/launchd."""
from __future__ import annotations

import argparse
import json

from engine.resolution.ops import run_prefetch


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--force", action="store_true", help="run even if today is not a trading day")
    ap.add_argument("--no-yahoo", action="store_true", help="skip the Yahoo top-up for symbols bhavcopy missed")
    a = ap.parse_args(argv)
    adapter = None
    if not a.no_yahoo:
        from scripts.common import bootstrap  # noqa: F401  (adapter construction only)
        from src.config import load_rule_spec
        from src.data.adapter import build_adapter
        adapter = build_adapter(load_rule_spec("config/rules_literal.yaml"))
    out = run_prefetch(force=a.force, adapter=adapter)
    print(json.dumps(out, indent=2, default=str))
    return 1 if any(str(v).startswith("failed") for v in out.get("steps", {}).values()) else 0


if __name__ == "__main__":
    raise SystemExit(main())
