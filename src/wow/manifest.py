"""Manifest builder (docs/wow-arm-history-analysis-plan.md §6.2-6.3): source file
hashes, seed, registry checksums, UTC — never in the data rows themselves, so two
builds over unchanged inputs stay byte-identical (T-07)."""
from __future__ import annotations

import glob
import hashlib
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _hash_file(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def _hash_glob(pattern: str) -> dict:
    files = sorted(glob.glob(str(ROOT / pattern)))
    return {Path(f).relative_to(ROOT).as_posix(): _hash_file(Path(f)) for f in files}


def build_manifest(seed: int, nifty50_source: dict) -> dict:
    from src.flags.registry import load_registry as load_flags_registry, checksum as flags_checksum
    from src.experiments.threshold import load_registry as load_threshold_registry, checksum as threshold_checksum
    from src.config import load_rule_spec

    rule_spec = load_rule_spec(str(ROOT / "config" / "rules.yaml"))
    flags_reg = load_flags_registry()
    threshold_reg = load_threshold_registry(rule_spec=rule_spec)

    return {
        "built_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "bootstrap_seed": seed,
        "bootstrap_block_len": 4,
        "bootstrap_n_boot": 10_000,
        "nifty50": nifty50_source,
        "registry_checksums": {
            "feature_flags.yaml": flags_checksum(flags_reg),
            "threshold_experiment.yaml": threshold_checksum(threshold_reg),
        },
        "source_file_hashes": {
            "replay": _hash_glob("results/feature_flags/replay/flags_*_graded.csv"),
            "experiments": _hash_glob("results/experiments/V*_trades.csv"),
            "forward_test": _hash_glob("results/forward_test/picks_*.json"),
        },
    }
