"""Loads config/data_resolution.yaml and config/index_registry.yaml (no hard-coded provider URLs in code)."""
from __future__ import annotations

import copy
import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]

DEFAULTS = {
    "fallback": {"allow_approx_universe": True, "unfeedable_policy": "run_labeled"},
    "scoring": {"exclude_partial_runs": True},
    "coverage": {"complete_min": 0.95, "partial_min": 0.70},
    "providers": {"timeout_s": 15, "retries": 2, "backoff_s": 0.5, "max_req_per_s": 2,
                  "nse": {"enabled": True}, "niftyindices": {"enabled": True, "user_agent": "Mozilla/5.0"}},
    "universe": {"snapshot_tolerance_days": 183, "cache_dir": "data_cache/index_lists", "upload_dir": "data_cache/uploads"},
    "history": {"buffer_pct": 0.20},
}


def _merge(base: dict, over: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        out[k] = _merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def load_config(path: str | Path | None = None) -> dict:
    p = Path(path) if path else ROOT / "config" / "data_resolution.yaml"
    over = yaml.safe_load(p.read_text()) if p.exists() else {}
    return _merge(DEFAULTS, over or {})


def norm_key(name: str) -> str:
    return re.sub(r"[^A-Z0-9]+", "", name.upper())


class IndexRegistry:
    def __init__(self, raw: dict):
        self.base_url = raw.get("base_url", "")
        self.indices = raw.get("indices", {})
        self._alias = {}
        for canon, spec in self.indices.items():
            for a in [canon, *spec.get("aliases", [])]:
                self._alias[norm_key(a)] = canon

    def canonical(self, name: str) -> str | None:
        return self._alias.get(norm_key(name))

    def spec(self, name: str) -> dict | None:
        c = self.canonical(name)
        return self.indices.get(c) if c else None

    def url(self, name: str) -> str | None:
        s = self.spec(name)
        return self.base_url + s["file"] if s and s.get("file") else None

    def slug(self, name: str) -> str:
        return re.sub(r"[^a-z0-9]+", "_", (self.canonical(name) or name).lower()).strip("_")


def load_registry(path: str | Path | None = None) -> IndexRegistry:
    p = Path(path) if path else ROOT / "config" / "index_registry.yaml"
    return IndexRegistry(yaml.safe_load(p.read_text()) if p.exists() else {})
