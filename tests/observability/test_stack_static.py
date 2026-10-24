"""Static validation of observability/ (Grafana Cloud edition). None of this has been loaded into a live Grafana: these tests are the
safety net. Dashboards and alert rules only reference metrics that exist in the code, every datasource uid is one the sync tool knows,
committed dashboards equal the generator's output, secrets are not committed. promtool is used when on PATH and skipped otherwise.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

from observability import build as ob

ROOT = Path(__file__).resolve().parents[2]
OBS = ROOT / "observability"
CATALOG = json.loads((OBS / "metrics-catalog.json").read_text())["metrics"]
CATALOG_NAMES = {m["name"] for m in CATALOG}
DS_UIDS = {"prom", "loki", "tempo", "supabase"}        # logical uids; observability.cloud maps the first three to the stack's real ones
DASHBOARDS = sorted((OBS / "grafana/dashboards").glob("*.json"))
from observability import cloud as obcloud
RULES = obcloud.alert_payloads({"prom": "prom"}, folder_uid=obcloud.FOLDER_UID, env={})

PROMQL_WORDS = {"last_over_time", "rate", "increase", "sum", "max", "min", "avg", "by", "without", "histogram_quantile", "clamp_min", "time", "le", "scalar", "irate", "count", "bool", "on", "ignoring", "or", "and", "unless"}


def metrics_in(expr: str) -> set[str]:
    """Metric names in a PromQL expression: strip label matchers, by()/without() clauses and Grafana variables, drop function names and numbers."""
    e = re.sub(r"\$\{?[A-Za-z_]+\}?", "0", expr)
    e = re.sub(r"\{[^}]*\}", "", e)
    e = re.sub(r"\b(by|without)\s*\([^)]*\)", "", e)
    names = set()
    for m in re.finditer(r"[A-Za-z_:][A-Za-z0-9_:]*", e):
        w = m.group(0)
        if w in PROMQL_WORDS or re.fullmatch(r"\d+(e\d+)?", w):
            continue
        if e[m.end():m.end() + 1] == "(":
            continue                                                    # a function
        names.add(re.sub(r"_(bucket|sum|count)$", "", w) if w not in CATALOG_NAMES else w)
    return {n for n in names if "_" in n or n in CATALOG_NAMES}


def balanced(s: str) -> bool:
    stack, pairs = [], {")": "(", "]": "[", "}": "{"}
    q = None
    for ch in s:
        if q:
            q = None if ch == q else q
        elif ch in "\"'":
            q = ch
        elif ch in "([{":
            stack.append(ch)
        elif ch in pairs and (not stack or stack.pop() != pairs[ch]):
            return False
    return not stack and q is None


def all_exprs():
    for r in RULES:
        yield f"rule {r['uid']}", next(d["model"]["expr"] for d in r["data"] if d["refId"] == "A")
    for f in DASHBOARDS:
        for p in json.loads(f.read_text())["panels"]:
            for t in p.get("targets", []):
                if t.get("expr") and (t.get("datasource") or {}).get("uid") == "prom":
                    yield f"{f.stem} / {p['title']}", t["expr"]


# ---- generated artefacts ------------------------------------------------------------------------------------------------------
def test_committed_dashboards_equal_the_builder_output():
    built = ob.build()
    assert set(built) == {f"grafana/dashboards/{n}.json" for n in ob.DASHBOARDS}
    for rel, content in built.items():
        assert (OBS / rel).read_text() == content, f"{rel} is stale: run `python -m observability.build`"
    assert sorted(f.name for f in (OBS / "grafana/dashboards").glob("*.json")) == sorted(Path(r).name for r in built), "a dashboard file has no generator"


def test_there_are_six_dashboards_with_unique_uids_and_ids():
    assert [f.stem for f in DASHBOARDS] == sorted(ob.DASHBOARDS)
    uids = []
    for f in DASHBOARDS:
        d = json.loads(f.read_text())
        uids.append(d["uid"])
        ids = [p["id"] for p in d["panels"]]
        assert len(ids) == len(set(ids)) and d["panels"] and d["schemaVersion"] >= 39
    assert len(uids) == len(set(uids)) == 6


def test_every_panel_datasource_uid_is_provisioned():
    for f in DASHBOARDS:
        d = json.loads(f.read_text())
        for p in d["panels"]:
            if p["type"] == "text":
                continue
            assert p["datasource"]["uid"] in DS_UIDS, f"{f.stem}/{p['title']}"
            for t in p["targets"]:
                assert t["datasource"]["uid"] in DS_UIDS
        for v in d["templating"]["list"]:
            if v.get("datasource"):
                assert v["datasource"]["uid"] in DS_UIDS


def test_every_promql_metric_exists_in_the_catalog_and_expressions_are_well_formed():
    seen = 0
    for where, expr in all_exprs():
        seen += 1
        assert balanced(expr), f"{where}: unbalanced {expr}"
        unknown = metrics_in(expr) - CATALOG_NAMES
        assert not unknown, f"{where}: {sorted(unknown)} not in metrics-catalog.json"
    assert seen > 40


def test_catalog_tokens_exist_in_the_code_that_emits_them():
    for m in CATALOG:
        f = ROOT / m["source"]["file"]
        if not f.exists():
            pytest.fail(f"{m['name']}: source file missing {f}")
        assert m["source"]["token"] in f.read_text(), f"{m['name']}: token {m['source']['token']!r} not found in {m['source']['file']}"


def test_catalog_names_follow_the_otel_to_prometheus_naming_rules():
    for m in CATALOG:
        if m["type"] == "counter":
            assert m["name"].endswith("_total"), m["name"]
        if "duration" in m["name"] and m["type"] == "histogram":
            assert m["name"].endswith("_seconds"), m["name"]


def test_ten_alert_rules_with_required_fields():
    assert len(RULES) == 10 and len({r["uid"] for r in RULES}) == 10
    for r in RULES:
        assert r["labels"]["severity"] in {"warn", "page"} and r["condition"] == "C" and r["noDataState"] in {"OK", "Alerting"}
        assert {d["refId"] for d in r["data"]} == {"A", "B", "C"} and r["annotations"]["summary"] and r["for"]
        assert next(d for d in r["data"] if d["refId"] == "A")["datasourceUid"] == "prom"
    assert {r["title"] for r in RULES if r["labels"]["severity"] == "page"} == {"LLM failing", "Weekly run missed"}      # the plan's two pages
    exprs = " ".join(next(d for d in r["data"] if d["refId"] == "A")["model"]["expr"] for r in RULES)
    for needle in ("> 5", "> 0.05", "> 0.2", "0.8 *", "8 * 86400", "0.97 -", "> 0.1"):
        assert needle in exprs, needle


def test_pushed_gauges_are_always_read_through_last_over_time():
    """screener_* and golden_suite_accuracy come from short-lived processes: the series is stale minutes after they exit."""
    pushed = ("screener_job_last_success_timestamp", "screener_universe_size", "screener_candidates", "golden_suite_accuracy")
    for where, expr in all_exprs():
        for m in pushed:
            for hit in re.finditer(m, expr):
                before = expr[:hit.start()]
                assert before.rstrip().endswith("last_over_time(") or re.search(r"last_over_time\([^()]*$", before), f"{where}: {m} not wrapped in last_over_time: {expr}"


def test_a_job_that_never_reported_alerts_instead_of_staying_quiet():
    r = next(x for x in RULES if x["uid"] == "ps-alert-weekly-run-missed")
    assert r["noDataState"] == "Alerting"


def test_budget_placeholder_is_expanded_when_the_rule_is_built_for_the_stack():
    p = obcloud.alert_payloads({"prom": "p"}, "f", {"LLM_WEEKLY_GPU_SECONDS_BUDGET": "123"})
    assert "0.8 * 123" in next(r for r in p if r["uid"] == "ps-alert-cloud-budget")["data"][0]["model"]["expr"]


def test_run_explorer_has_the_pickers_tables_and_trace_links():
    d = json.loads((OBS / "grafana/dashboards/run-explorer.json").read_text())
    assert {v["name"] for v in d["templating"]["list"]} == {"prompt_id", "run_id"}
    tables = {p["title"]: p for p in d["panels"] if p["type"] == "table"}
    assert {"Tasks", "Agent calls", "Tool calls (incl. llm.chat)"} <= set(tables)
    for t in ("Tasks", "Agent calls", "Tool calls (incl. llm.chat)"):
        ov = {o["matcher"]["options"]: o["properties"] for o in tables[t]["fieldConfig"]["overrides"]}
        assert any(p["id"] == "links" for p in ov["trace_id"])
        assert any(p["value"].get("type") == "json-view" for p in ov["input"] if p["id"] == "custom.cellOptions")


def test_sql_panels_only_read_the_observability_schema():
    for f in DASHBOARDS:
        for p in json.loads(f.read_text())["panels"]:
            for t in p.get("targets", []):
                sql = t.get("rawSql")
                if sql:
                    assert re.search(r"\bobservability\.", sql) and not re.search(r"\b(insert|update|delete|drop|alter|create)\b", sql, re.I), f"{f.stem}/{p['title']}"


def test_no_secret_is_committed_in_the_observability_directory():
    for f in OBS.rglob("*"):
        if f.is_file() and f.name != ".env" and f.suffix not in {".pyc"}:
            text = f.read_text(errors="ignore")
            assert not re.search(r"glsa_[A-Za-z0-9]{8,}|glc_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{20,}\.", text), f"secret-looking token in {f}"


def test_env_example_lists_every_variable_the_tooling_reads():
    keys = {l.split("=")[0] for l in (OBS / ".env.example").read_text().splitlines() if "=" in l and not l.startswith("#")}
    assert {"OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_HEADERS", "GRAFANA_URL", "GRAFANA_SA_TOKEN", "GRAFANA_PG_HOST", "GRAFANA_PG_DATABASE", "GRAFANA_PG_USER",
            "GRAFANA_PG_PASSWORD", "ALERT_WEBHOOK_URL", "LLM_WEEKLY_GPU_SECONDS_BUDGET", "GRAFANA_OTLP_INSTANCE_ID", "GRAFANA_OTLP_TOKEN"} <= keys
    assert (ROOT / ".gitignore").read_text().count(".env") >= 1


@pytest.mark.skipif(shutil.which("promtool") is None, reason="promtool not installed")
def test_promtool_accepts_every_alert_expression(tmp_path):
    for i, r in enumerate(RULES):
        expr = next(d["model"]["expr"] for d in r["data"] if d["refId"] == "A")
        f = tmp_path / f"r{i}.yml"
        f.write_text(yaml.safe_dump({"groups": [{"name": "g", "rules": [{"alert": "A", "expr": expr}]}]}))
        out = subprocess.run(["promtool", "check", "rules", str(f)], capture_output=True, text=True)
        assert out.returncode == 0, f"{r['uid']}: {out.stderr}"
