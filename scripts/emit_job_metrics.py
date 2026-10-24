"""Weekly job metrics for Grafana Cloud (docs/production-llm-cloud-observability-plan.md, Part B).

Reads the artifacts the weekly jobs already wrote (READ-ONLY, never imports or edits tests/track_*.py -- those are frozen /
immutable under .claude/HARNESS.md) and sends gauges over OTLP:

    screener_job_last_success_timestamp{screener_job}   unix seconds of the job's latest good record
    screener_universe_size{screener_job, arm}           funnel.candidate_universe of that record
    screener_candidates{screener_job, arm}              survivors / extra confirmations of that record

Why from artifacts and not from the shell exit status: scripts/weekly_selection_run.sh swallows failures with `|| true`, and
`track_forward record` REFUSES to overwrite an existing week. Success is "a valid record for the week exists", and re-sending the
same timestamp is idempotent, so a re-run never leaves the gauge stale. A missing / unreadable artifact sends nothing for that job.
Dashboards and alerts read these with `last_over_time(...[30d])` because a pushed series goes stale minutes after this process
exits (Grafana Cloud has no Pushgateway); the "weekly run missed" alert then fires on the age of the last sample.
This script always exits 0 and never blocks selection.

    python -m scripts.emit_job_metrics [--results-dir results] [--dry-run]     # needs OTEL_EXPORTER_OTLP_ENDPOINT / _HEADERS
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path


@dataclass
class JobSample:
    job: str
    last_success: float
    source: str
    universe: dict[str, float] = field(default_factory=dict)      # arm -> size
    candidates: dict[str, float] = field(default_factory=dict)    # arm -> count


def _ts(value: str) -> float:
    return datetime.fromisoformat(value).timestamp()


def _load(path: str):
    with open(path) as fh:
        return json.load(fh)


def _latest(pattern: str, exclude: str | None = None) -> str | None:
    files = sorted(f for f in glob.glob(pattern) if not (exclude and f.endswith(exclude)))
    return files[-1] if files else None


def collect(results_dir: str | Path) -> list[JobSample]:
    rd = Path(results_dir)
    out: list[JobSample] = []

    def attempt(job: str, fn):
        try:
            s = fn()
            if s is not None:
                out.append(s)
        except Exception as exc:                                         # noqa: BLE001 - one unreadable artifact must not hide the others
            print(f"emit_job_metrics: {job}: skipped ({type(exc).__name__}: {exc})", file=sys.stderr)

    def weekly_select():
        f = _latest(str(rd / "forward_test" / "picks_????-??-??.json"))
        if not f:
            return None
        rec = _load(f)
        return JobSample("weekly_select", _ts(rec["created_utc"]), f,
                         universe={"control": float(rec["funnel"]["candidate_universe"])}, candidates={"control": float(rec["n_survivors"])})

    def forward_test():                     # the T1 shadow record is the second step of the weekly forward-test cycle
        f = _latest(str(rd / "forward_test" / "picks_????-??-??_t1.json"))
        if not f:
            return None
        rec = _load(f)
        return JobSample("forward_test", _ts(rec["created_utc"]), f, candidates={"t1": float(rec["n_extra_confirmed"])})

    def flag_matrix():
        f = rd / "feature_flags" / "run_log.jsonl"
        if not f.exists():
            return None
        good = []
        for line in f.read_text().splitlines():
            if not line.strip():
                continue
            r = json.loads(line)
            if r.get("error") is None and (r.get("checks_summary") or {}).get("n_fail", 1) == 0:
                good.append(r)
        return JobSample("flag_matrix", _ts(good[-1]["ended_ist"]), str(f)) if good else None

    def threshold_experiment():
        f = _latest(str(rd / "threshold_experiment" / "threshold_????-??-??.json"))
        if not f:
            return None
        return JobSample("threshold_experiment", _ts(_load(f)["created_utc"]), f)

    for name, fn in (("weekly_select", weekly_select), ("forward_test", forward_test), ("flag_matrix", flag_matrix), ("threshold_experiment", threshold_experiment)):
        attempt(name, fn)
    return out


def gauges_of(sample: JobSample) -> list[tuple[str, dict, float]]:
    out: list[tuple[str, dict, float]] = [("screener_job_last_success_timestamp", {"screener_job": sample.job}, sample.last_success)]
    out += [("screener_universe_size", {"screener_job": sample.job, "arm": arm}, v) for arm, v in sample.universe.items()]
    out += [("screener_candidates", {"screener_job": sample.job, "arm": arm}, v) for arm, v in sample.candidates.items()]
    return out


def render(samples: list[JobSample]) -> str:
    lines = []
    for s in samples:
        for name, labels, value in gauges_of(s):
            lab = ",".join(f'{k}="{v}"' for k, v in sorted(labels.items()))
            lines.append(f"{name}{{{lab}}} {value}")
    return "\n".join(lines) + ("\n" if lines else "")


def push(samples: list[JobSample], env=None, pusher=None) -> int:
    """All gauges in one OTLP flush. Returns the number of jobs sent (0 if nothing is configured or the flush failed)."""
    if pusher is None:
        from src.telemetry.gauges import push_gauges as pusher
    gauges = [g for s in samples for g in gauges_of(s)]
    if not gauges:
        return 0
    return len(samples) if pusher(gauges, env=env) else 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--results-dir", default=str(Path(__file__).resolve().parents[1] / "results"))
    ap.add_argument("--dry-run", action="store_true", help="print the gauges instead of sending them")
    a = ap.parse_args(argv)
    try:
        from src.telemetry import otlp
        samples = collect(a.results_dir)
        if a.dry_run or not otlp.configured(os.environ):
            print(render(samples), end="")
        else:
            n = push(samples)
            print(f"emit_job_metrics: sent {n}/{len(samples)} jobs over OTLP")
    except Exception as exc:                                             # noqa: BLE001 - never block the weekly selection run
        print(f"emit_job_metrics: error ({type(exc).__name__}: {exc})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
