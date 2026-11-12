import json
from pathlib import Path

from scripts import emit_job_metrics as ejm


def put(p: Path, obj):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj))


def results(tmp_path, *, picks=True, t1=True, flags=True, thr=True):
    rd = tmp_path / "results"
    if picks:
        put(rd / "forward_test" / "picks_2026-09-14.json", {"created_utc": "2026-09-14T04:00:00+00:00", "funnel": {"candidate_universe": 400}, "n_survivors": 1})
        put(rd / "forward_test" / "picks_2026-09-21.json", {"created_utc": "2026-09-28T15:04:08+00:00", "funnel": {"candidate_universe": 501}, "n_survivors": 2})
    if t1:
        put(rd / "forward_test" / "picks_2026-09-14_t1.json", {"created_utc": "2026-09-19T20:10:57+00:00", "n_extra_confirmed": 9})
    if flags:
        f = rd / "feature_flags" / "run_log.jsonl"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text("\n".join(json.dumps(r) for r in [
            {"ended_ist": "2026-09-21T20:00:00+05:30", "error": None, "checks_summary": {"n_fail": 0}},
            {"ended_ist": "2026-09-28T20:34:16+05:30", "error": "boom", "checks_summary": {"n_fail": 0}},          # failed run: ignored
            {"ended_ist": "2026-09-29T20:00:00+05:30", "error": None, "checks_summary": {"n_fail": 2}},           # failing checks: ignored
        ]) + "\n")
    if thr:
        put(rd / "threshold_experiment" / "threshold_2026-09-21.json", {"created_utc": "2026-09-28T15:04:12+00:00"})
    return rd


def by_job(samples):
    return {s.job: s for s in samples}


def test_collects_the_latest_good_record_per_job(tmp_path):
    s = by_job(ejm.collect(results(tmp_path)))
    assert set(s) == {"weekly_select", "forward_test", "flag_matrix", "threshold_experiment"}
    assert s["weekly_select"].universe == {"control": 501.0} and s["weekly_select"].candidates == {"control": 2.0}
    assert s["weekly_select"].last_success == ejm._ts("2026-09-28T15:04:08+00:00")
    assert s["forward_test"].candidates == {"t1": 9.0}
    assert s["flag_matrix"].last_success == ejm._ts("2026-09-21T20:00:00+05:30")      # the only run with no error AND no failed checks


def test_a_missing_or_corrupt_artifact_skips_only_that_job(tmp_path, capsys):
    rd = results(tmp_path, t1=False)
    (rd / "feature_flags" / "run_log.jsonl").write_text("{not json\n")
    s = by_job(ejm.collect(rd))
    assert set(s) == {"weekly_select", "threshold_experiment"}
    assert "flag_matrix: skipped" in capsys.readouterr().err


def test_gauges_use_screener_job_not_the_reserved_job_label(tmp_path):
    g = {(n, tuple(sorted(l.items()))): v for s in ejm.collect(results(tmp_path)) for n, l, v in ejm.gauges_of(s)}
    assert g[("screener_job_last_success_timestamp", (("screener_job", "weekly_select"),))] == ejm._ts("2026-09-28T15:04:08+00:00")
    assert g[("screener_universe_size", (("arm", "control"), ("screener_job", "weekly_select")))] == 501.0
    assert g[("screener_candidates", (("arm", "t1"), ("screener_job", "forward_test")))] == 9.0
    text = ejm.render(ejm.collect(results(tmp_path)))
    assert 'screener_universe_size{arm="control",screener_job="weekly_select"} 501.0' in text


def test_all_gauges_go_out_in_one_otlp_flush(tmp_path):
    calls = []
    n = ejm.push(ejm.collect(results(tmp_path)), env={}, pusher=lambda gauges, env=None: calls.append(gauges) or True)
    assert n == 4 and len(calls) == 1
    assert {name for name, _, _ in calls[0]} == {"screener_job_last_success_timestamp", "screener_universe_size", "screener_candidates"}


def test_a_failed_flush_reports_zero_and_never_raises(tmp_path):
    assert ejm.push(ejm.collect(results(tmp_path)), pusher=lambda gauges, env=None: False) == 0
    assert ejm.push([], pusher=lambda gauges, env=None: True) == 0


def test_main_prints_when_no_otlp_endpoint_is_configured_and_always_exits_zero(tmp_path, capsys, monkeypatch):
    for k in ("OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"):
        monkeypatch.delenv(k, raising=False)
    assert ejm.main(["--results-dir", str(results(tmp_path))]) == 0
    assert "screener_job_last_success_timestamp" in capsys.readouterr().out
    assert ejm.main(["--results-dir", str(tmp_path / "does-not-exist")]) == 0


def test_the_real_results_directory_parses(capsys):
    """Smoke: today's actual artifacts are readable by the collector (skips, never raises)."""
    root = Path(__file__).resolve().parents[2] / "results"
    if root.exists():
        assert isinstance(ejm.collect(root), list)
