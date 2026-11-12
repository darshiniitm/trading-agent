"""Source of truth for the six Grafana dashboards (grafana/dashboards/*.json, generated) and the ten alert rules (RULES, below).
Dashboards are code: edit here, run `python -m observability.build`, commit the output. `python -m observability.cloud sync` uploads
both to a Grafana Cloud stack (it maps the logical datasource uids prom / loki / tempo / supabase to the stack's real ones).

tests/observability checks the committed dashboards equal this output, that every PromQL metric is in metrics-catalog.json and that
every datasource uid is one the sync tool knows. Nothing here has been loaded into a live Grafana yet.

Pushed gauges (screener_*, golden_suite_accuracy) come from short-lived processes over OTLP, and a series goes stale minutes after
its process exits, so every query on them uses last_over_time(metric[30d]).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from urllib.parse import quote


ROOT = Path(__file__).resolve().parent
PROM = {"type": "prometheus", "uid": "prom"}
LOKI = {"type": "loki", "uid": "loki"}
TEMPO = {"type": "tempo", "uid": "tempo"}
PG = {"type": "grafana-postgresql-datasource", "uid": "supabase"}

P95_BUDGET_S = 5          # the plan's interpreter latency budget


# ---- panel helpers -------------------------------------------------------------------------------------------------------
class Board:
    def __init__(self, uid: str, title: str, description: str, tags=()):
        self.uid, self.title, self.description, self.tags = uid, title, description, list(tags)
        self.panels: list[dict] = []
        self.variables: list[dict] = []
        self._id = 0

    def _next(self) -> int:
        self._id += 1
        return self._id

    def ts(self, title, targets, x, y, w=12, h=8, unit="short", ds=PROM, threshold: float | None = None, description="", stack=False):
        defaults = {"unit": unit, "custom": {"lineWidth": 1, "fillOpacity": 10, **({"stacking": {"mode": "normal"}} if stack else {})}}
        if threshold is not None:
            defaults["custom"]["thresholdsStyle"] = {"mode": "line"}
            defaults["thresholds"] = {"mode": "absolute", "steps": [{"color": "green", "value": None}, {"color": "red", "value": threshold}]}
        self.panels.append({"id": self._next(), "type": "timeseries", "title": title, "description": description, "datasource": ds, "gridPos": {"x": x, "y": y, "w": w, "h": h},
                            "fieldConfig": {"defaults": defaults, "overrides": []}, "options": {"legend": {"displayMode": "list", "placement": "bottom"}, "tooltip": {"mode": "multi"}},
                            "targets": [{"refId": chr(65 + i), "datasource": ds, "expr": e, "legendFormat": legend, "range": True} for i, (e, legend) in enumerate(targets)]})

    def stat(self, title, expr, x, y, w=6, h=4, unit="short", ds=PROM, thresholds=None, description=""):
        steps = thresholds or [{"color": "green", "value": None}]
        self.panels.append({"id": self._next(), "type": "stat", "title": title, "description": description, "datasource": ds, "gridPos": {"x": x, "y": y, "w": w, "h": h},
                            "fieldConfig": {"defaults": {"unit": unit, "thresholds": {"mode": "absolute", "steps": steps}}, "overrides": []},
                            "options": {"reduceOptions": {"calcs": ["lastNotNull"]}, "colorMode": "value"},
                            "targets": [{"refId": "A", "datasource": ds, "expr": expr, "instant": True}]})

    def sql_stat(self, title, sql, x, y, w=6, h=4, unit="short"):
        self.panels.append({"id": self._next(), "type": "stat", "title": title, "datasource": PG, "gridPos": {"x": x, "y": y, "w": w, "h": h},
                            "fieldConfig": {"defaults": {"unit": unit}, "overrides": []}, "options": {"reduceOptions": {"calcs": ["lastNotNull"]}},
                            "targets": [{"refId": "A", "datasource": PG, "format": "table", "rawQuery": True, "editorMode": "code", "rawSql": sql}]})

    def sql_ts(self, title, sql, x, y, w=12, h=8, unit="short"):
        self.panels.append({"id": self._next(), "type": "timeseries", "title": title, "datasource": PG, "gridPos": {"x": x, "y": y, "w": w, "h": h},
                            "fieldConfig": {"defaults": {"unit": unit, "custom": {"lineWidth": 1, "fillOpacity": 10}}, "overrides": []},
                            "targets": [{"refId": "A", "datasource": PG, "format": "time_series", "rawQuery": True, "editorMode": "code", "rawSql": sql}]})

    def sql_table(self, title, sql, x, y, w=24, h=9, json_cols=(), link_trace=True, description=""):
        overrides = [{"matcher": {"id": "byName", "options": c}, "properties": [{"id": "custom.cellOptions", "value": {"type": "json-view"}}, {"id": "custom.inspect", "value": True}]} for c in json_cols]
        if link_trace:
            overrides.append({"matcher": {"id": "byName", "options": "trace_id"}, "properties": [{"id": "links", "value": [
                {"title": "Open trace in Tempo", "url": _explore(TEMPO, {"queryType": "traceql", "query": "${__value.raw}"}), "targetBlank": True},
                {"title": "Logs for this trace in Loki", "url": _explore(LOKI, {"expr": '{service_name=~".+"} | trace_id = "${__value.raw}"'}), "targetBlank": True}]}]})
        self.panels.append({"id": self._next(), "type": "table", "title": title, "description": description, "datasource": PG, "gridPos": {"x": x, "y": y, "w": w, "h": h},
                            "fieldConfig": {"defaults": {"custom": {"cellOptions": {"type": "auto"}, "filterable": True}}, "overrides": overrides}, "options": {"showHeader": True},
                            "targets": [{"refId": "A", "datasource": PG, "format": "table", "rawQuery": True, "editorMode": "code", "rawSql": sql}]})

    def traces(self, title, query, x, y, w=24, h=9):
        self.panels.append({"id": self._next(), "type": "table", "title": title, "datasource": TEMPO, "gridPos": {"x": x, "y": y, "w": w, "h": h},
                            "targets": [{"refId": "A", "datasource": TEMPO, "queryType": "traceql", "query": query, "limit": 50}]})

    def logs(self, title, expr, x, y, w=24, h=9):
        self.panels.append({"id": self._next(), "type": "logs", "title": title, "datasource": LOKI, "gridPos": {"x": x, "y": y, "w": w, "h": h},
                            "options": {"showTime": True, "wrapLogMessage": True, "enableLogDetails": True}, "targets": [{"refId": "A", "datasource": LOKI, "expr": expr}]})

    def text(self, content, x, y, w=24, h=3):
        self.panels.append({"id": self._next(), "type": "text", "title": "", "gridPos": {"x": x, "y": y, "w": w, "h": h}, "options": {"mode": "markdown", "content": content}})

    def var_textbox(self, name, default, label):
        self.variables.append({"type": "textbox", "name": name, "label": label, "query": default, "current": {"text": default, "value": default}, "hide": 0})

    def var_sql(self, name, sql, label, include_all=True):
        self.variables.append({"type": "query", "name": name, "label": label, "datasource": PG, "query": sql, "refresh": 2, "includeAll": include_all, "allValue": "%",
                               "multi": False, "current": {"text": "All", "value": "$__all"} if include_all else {}, "hide": 0, "sort": 0})

    def render(self) -> dict:
        return {"uid": self.uid, "title": self.title, "description": self.description, "tags": ["prompt-screener", *self.tags], "timezone": "browser", "schemaVersion": 39, "version": 1,
                "editable": False, "graphTooltip": 1, "refresh": "30s", "time": {"from": "now-6h", "to": "now"}, "templating": {"list": self.variables},
                "annotations": {"list": []}, "links": [], "panels": self.panels}


def _explore(ds: dict, query: dict) -> str:
    left = {"datasource": ds["uid"], "queries": [{"refId": "A", "datasource": ds, **query}], "range": {"from": "now-24h", "to": "now"}}
    return "/explore?orgId=1&left=" + quote(json.dumps(left, separators=(",", ":")), safe="${}_").replace("%24%7B__value.raw%7D", "${__value.raw}")


def hq(q: float, metric: str, by: str = "le", rng: str = "5m", sel: str = "") -> str:
    return f"histogram_quantile({q}, sum by ({by}) (rate({metric}_bucket{sel}[{rng}])))"


# ---- the six dashboards --------------------------------------------------------------------------------------------------
def llm_health() -> Board:
    b = Board("ps-llm-health", "LLM health", "Interpreter model calls: latency, errors, tokens, fallback, and cloud GPU-seconds against the weekly budget.", ["llm"])
    b.var_textbox("budget", "1000000000", "Weekly GPU-seconds budget")
    b.ts("Request latency p50 / p95 / p99 by model", [(hq(0.5, "llm_request_duration_seconds", "le, model"), "p50 {{model}}"), (hq(0.95, "llm_request_duration_seconds", "le, model"), "p95 {{model}}"),
                                                       (hq(0.99, "llm_request_duration_seconds", "le, model"), "p99 {{model}}")], 0, 0, unit="s", threshold=P95_BUDGET_S)
    b.ts("Requests by status (error mix)", [('sum by (status) (rate(llm_requests_total[5m]))', "{{status}}")], 12, 0, unit="reqps", stack=True)
    b.ts("Tokens per second", [('sum by (direction) (rate(llm_tokens_total[5m]))', "{{direction}}")], 0, 8, unit="short")
    b.ts("Fallback and retry rate", [('sum(rate(llm_fallback_total[15m]))', "fallbacks/s"), ('sum(rate(llm_retry_total[15m]))', "retries/s"),
                                     ('sum(rate(llm_fallback_total[15m])) / clamp_min(sum(rate(llm_requests_total[15m])), 1e-9)', "fallback share")], 12, 8)
    b.stat("GPU-seconds, last 7 days", "sum(increase(llm_gpu_seconds_total[7d]))", 0, 16, unit="s", description="Ollama total_duration summed: the proxy for Ollama Cloud usage consumed (there is no quota header).")
    b.stat("Budget used", "sum(increase(llm_gpu_seconds_total[7d])) / $budget", 6, 16, unit="percentunit",
           thresholds=[{"color": "green", "value": None}, {"color": "orange", "value": 0.8}, {"color": "red", "value": 1}])
    b.stat("Non-ok share (1h)", 'sum(rate(llm_requests_total{status!="ok"}[1h])) / clamp_min(sum(rate(llm_requests_total[1h])), 1e-9)', 12, 16, unit="percentunit",
           thresholds=[{"color": "green", "value": None}, {"color": "orange", "value": 0.05}, {"color": "red", "value": 0.2}])
    b.stat("Dropped run-record rows (1h)", "sum(increase(telemetry_dropped_total[1h]))", 18, 16, thresholds=[{"color": "green", "value": None}, {"color": "orange", "value": 1}],
           description="Rows the bounded writer queue had to drop (database slow or down). Should be zero.")
    return b


def prompt_pipeline() -> Board:
    b = Board("ps-prompt-pipeline", "Prompt pipeline", "Where a prompt run spends its time: stage latency against the 5 s line, task breakdown, LLM share, bad-JSON rate, slow traces.", ["pipeline"])
    b.ts("Request processing time p50 / p95 by stage", [(hq(0.5, "prompt_run_duration_seconds", "le, stage"), "p50 {{stage}}"), (hq(0.95, "prompt_run_duration_seconds", "le, stage"), "p95 {{stage}}")],
         0, 0, unit="s", threshold=P95_BUDGET_S, description="Processing time of each request (compile / screen / confirm), not wall-clock since the draft was created.")
    b.ts("Average task duration", [('sum by (task) (rate(task_duration_seconds_sum[15m])) / clamp_min(sum by (task) (rate(task_duration_seconds_count[15m])), 1e-9)', "{{task}}")], 12, 0, unit="s")
    b.stat("LLM share of interpreter time (1h)", 'sum(rate(llm_request_duration_seconds_sum[1h])) / clamp_min(sum(rate(prompt_run_duration_seconds_sum{stage="compile"}[1h])), 1e-9)', 0, 8, unit="percentunit")
    b.stat("Bad-JSON rate (1h)", 'sum(rate(llm_requests_total{status="bad_json"}[1h])) / clamp_min(sum(rate(llm_requests_total[1h])), 1e-9)', 6, 8, unit="percentunit",
           thresholds=[{"color": "green", "value": None}, {"color": "orange", "value": 0.01}, {"color": "red", "value": 0.05}])
    b.stat("Interpreter p95 (15m)", hq(0.95, "prompt_run_duration_seconds", "le", "15m", '{stage="compile"}'), 12, 8, unit="s",
           thresholds=[{"color": "green", "value": None}, {"color": "red", "value": P95_BUDGET_S}])
    b.stat("Requests failed (1h)", 'sum(increase(prompt_run_duration_seconds_count{outcome="error"}[1h]))', 18, 8, thresholds=[{"color": "green", "value": None}, {"color": "orange", "value": 1}])
    b.traces("Slow compile requests (click a trace id)", '{ name = "prompt.compile" && duration > 5s }', 0, 12)
    b.logs("Errors (Loki)", '{service_name=~".+"} | detected_level="error"', 0, 21)
    return b


def screener_jobs() -> Board:
    b = Board("ps-screener-jobs", "Screener jobs & data", "Weekly jobs: last success, universe and candidate counts per arm, and price-data failures by source.", ["jobs", "data"])
    b.stat("Days since last success - weekly_select", '(time() - max(last_over_time(screener_job_last_success_timestamp{screener_job="weekly_select"}[30d]))) / 86400', 0, 0, w=6, unit="d",
           thresholds=[{"color": "green", "value": None}, {"color": "orange", "value": 7}, {"color": "red", "value": 8}])
    b.stat("... forward_test", '(time() - max(last_over_time(screener_job_last_success_timestamp{screener_job="forward_test"}[30d]))) / 86400', 6, 0, w=6, unit="d",
           thresholds=[{"color": "green", "value": None}, {"color": "orange", "value": 7}, {"color": "red", "value": 8}])
    b.stat("... flag_matrix", '(time() - max(last_over_time(screener_job_last_success_timestamp{screener_job="flag_matrix"}[30d]))) / 86400', 12, 0, w=6, unit="d",
           thresholds=[{"color": "green", "value": None}, {"color": "orange", "value": 7}, {"color": "red", "value": 8}])
    b.stat("... threshold_experiment", '(time() - max(last_over_time(screener_job_last_success_timestamp{screener_job="threshold_experiment"}[30d]))) / 86400', 18, 0, w=6, unit="d",
           thresholds=[{"color": "green", "value": None}, {"color": "orange", "value": 7}, {"color": "red", "value": 8}])
    b.ts("Universe size", [('max by (screener_job, arm) (last_over_time(screener_universe_size[30d]))', "{{screener_job}} / {{arm}}")], 0, 4)
    b.ts("Candidates per arm", [('max by (screener_job, arm) (last_over_time(screener_candidates[30d]))', "{{screener_job}} / {{arm}}")], 12, 4)
    b.ts("Data-fetch failures by source (symbols/s)", [('sum by (source) (rate(data_fetch_errors_total[15m]))', "{{source}}")], 0, 12, description="symbol_bucket is a hash bucket (16), never a symbol.")
    b.ts("Data-fetch failure ratio", [('sum by (source) (rate(data_fetch_errors_total[15m])) / clamp_min(sum by (source) (rate(data_fetch_symbols_total[15m])), 1e-9)', "{{source}}")], 12, 12, unit="percentunit", threshold=0.1)
    return b


def product_usage() -> Board:
    b = Board("ps-product-usage", "Product usage", "From the run records in Supabase (observability.*). User ids are HMAC hashes. Watchlist sizes and per-condition usage live in the app's own SQLite store, not here.", ["product"])
    b.sql_ts("Prompt runs per day", "select date_trunc('day', started_at) as time, count(*) as runs from observability.runs where kind='prompt_run' and $__timeFilter(started_at) group by 1 order by 1", 0, 0)
    b.sql_ts("Active users per day", "select date_trunc('day', started_at) as time, count(distinct user_hash) as users from observability.runs where kind='prompt_run' and $__timeFilter(started_at) group by 1 order by 1", 12, 0)
    b.sql_stat("Confirmed prompts (range)", "select count(*) from observability.runs where kind='prompt_run' and status='ok' and $__timeFilter(started_at)", 0, 8)
    b.sql_stat("Failed confirms (range)", "select count(*) from observability.runs where kind='prompt_run' and status='error' and $__timeFilter(started_at)", 6, 8)
    b.sql_stat("Avg stocks screened -> kept", "select round(avg(rows_out)::numeric, 1) from observability.tool_calls where tool_name='screen.filter' and $__timeFilter(started_at)", 12, 8)
    b.sql_table("Most-used tools", "select tool_name, count(*) as calls, round(avg(duration_ms)) as avg_ms, count(*) filter (where status='error') as errors from observability.tool_calls where $__timeFilter(started_at) group by 1 order by 2 desc limit 20",
                0, 12, w=12, link_trace=False)
    b.sql_table("Most-used agents", "select agent_name, count(*) as calls, round(avg(duration_ms)) as avg_ms, sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens from observability.agent_calls where $__timeFilter(started_at) group by 1 order by 2 desc",
                12, 12, w=12, link_trace=False)
    return b


def interpreter_quality() -> Board:
    b = Board("ps-interpreter-quality", "Interpreter quality", "golden_suite_accuracy pushed by the eval scripts, local vs cloud, against the 97% target.", ["quality"])
    b.ts("Golden-suite accuracy", [('max by (provider, model, suite_version) (last_over_time(golden_suite_accuracy[30d]))', "{{provider}} {{model}} ({{suite_version}})")], 0, 0, w=16, unit="percentunit", threshold=0.97,
         description="The red line is the 97% target. Values are the latest pushed result, held for 30 days with last_over_time.")
    b.stat("Latest cloud accuracy", 'min(last_over_time(golden_suite_accuracy{provider="cloud"}[30d]))', 16, 0, w=4, unit="percentunit", thresholds=[{"color": "red", "value": None}, {"color": "green", "value": 0.97}])
    b.stat("Latest local accuracy", 'min(last_over_time(golden_suite_accuracy{provider="local"}[30d]))', 20, 0, w=4, unit="percentunit", thresholds=[{"color": "red", "value": None}, {"color": "green", "value": 0.97}])
    b.text("Cutover gate (plan A4): cloud accuracy >= local, p95 interpreter latency <= 5 s, zero unparseable JSON. Latency and bad-JSON are on *LLM health* and *Prompt pipeline*; "
           "`results/llm-parity/gate.json` holds the last gate decision.", 0, 8)
    return b


def run_explorer() -> Board:
    b = Board("ps-run-explorer", "Run explorer", "Pick a prompt id or run id: every task, agent call and tool call with status, duration, tokens and expandable input/output. Rows link to the trace and its logs.", ["runs"])
    b.var_sql("prompt_id", "select distinct prompt_id::text from observability.runs where prompt_id is not null order by 1 desc limit 200", "Prompt id")
    b.var_sql("run_id", "select run_id::text as __value, concat(to_char(started_at, 'MM-DD HH24:MI'), ' ', kind, ' ', status, ' p', coalesce(prompt_id::text, '-')) as __text from observability.runs where coalesce(prompt_id::text, '') like '$prompt_id' or '$prompt_id' = '%' order by started_at desc limit 200", "Run")
    sel = "run_id::text like '$run_id'"
    b.sql_table("Runs", "select started_at, kind, status, outcome, prompt_id, draft_id, user_hash, provider, model, duration_ms, error_type, error_msg, trace_id, run_id::text as run_id from observability.runs "
                        "where coalesce(prompt_id::text, '') like '$prompt_id' or '$prompt_id' = '%' order by started_at desc limit 200", 0, 0, h=8, json_cols=())
    b.sql_table("Tasks", f"select seq, task_name, status, duration_ms, rows_in, rows_out, input, output, error_type, error_msg, trace_id, span_id from observability.run_tasks where {sel} order by started_at", 0, 8, json_cols=("input", "output"))
    b.sql_table("Agent calls", f"select started_at, agent_name, agent_version, status, model, provider, input_tokens, output_tokens, gpu_ms, duration_ms, input, output, error_type, error_msg, trace_id, span_id from observability.agent_calls where {sel} order by started_at",
                0, 17, json_cols=("input", "output"))
    b.sql_table("Tool calls (incl. llm.chat)", f"select started_at, tool_name, status, duration_ms, rows_in, rows_out, model, input_tokens, output_tokens, gpu_ms, tool_args, input, output, error_type, error_msg, trace_id, span_id from observability.tool_calls where {sel} order by started_at",
                0, 26, h=10, json_cols=("tool_args", "input", "output"))
    b.ts("Agent calls per minute", [('sum by (agent) (rate(agent_invocations_total[5m])) * 60', "{{agent}}")], 0, 36, w=8)
    b.ts("Agent error rate", [('sum by (agent) (rate(agent_invocations_total{status="error"}[30m])) / clamp_min(sum by (agent) (rate(agent_invocations_total[30m])), 1e-9)', "{{agent}}")], 8, 36, w=8, unit="percentunit", threshold=0.1)
    b.ts("Agent p95 duration", [(hq(0.95, "agent_duration_seconds", "le, agent"), "{{agent}}")], 16, 36, w=8, unit="s")
    b.ts("Tool calls per minute", [('sum by (tool) (rate(tool_calls_total[5m])) * 60', "{{tool}}")], 0, 44, w=8)
    b.ts("Tool error rate", [('sum by (tool) (rate(tool_calls_total{status="error"}[30m])) / clamp_min(sum by (tool) (rate(tool_calls_total{status!="skipped"}[30m])), 1e-9)', "{{tool}}")], 8, 44, w=8, unit="percentunit", threshold=0.1)
    b.ts("Tool p95 duration", [(hq(0.95, "tool_duration_seconds", "le, tool"), "{{tool}}")], 16, 44, w=8, unit="s")
    b.sql_table("Tokens per agent (range)", "select agent_name, count(*) as calls, sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens, round(sum(gpu_ms)/1000.0, 1) as gpu_s from observability.agent_calls where $__timeFilter(started_at) group by 1 order by 3 desc nulls last",
                0, 52, w=24, h=6, link_trace=False)
    return b


DASHBOARDS = {"llm-health": llm_health, "prompt-pipeline": prompt_pipeline, "screener-jobs": screener_jobs, "product-usage": product_usage,
              "interpreter-quality": interpreter_quality, "run-explorer": run_explorer}


# ---- alert rules (Grafana-managed; the PromQL is the condition: non-empty result = firing) --------------------------------------
def _ratio(num: str, den: str) -> str:
    return f"({num}) / clamp_min(({den}), 1e-9)"


RULES = [
    dict(uid="ps-alert-interpreter-slow", title="Interpreter too slow", severity="warn", window=900, for_="15m",
         expr=hq(0.95, "prompt_run_duration_seconds", "le", "15m", '{stage="compile"}') + f" > {P95_BUDGET_S}",
         summary="Interpreter p95 above 5 s for 15 minutes", description="p95 of compile-request processing time exceeds the 5 s budget. See dashboard Prompt pipeline."),
    dict(uid="ps-alert-llm-failing", title="LLM failing", severity="page", window=600, for_="10m",
         expr=_ratio('sum(rate(llm_requests_total{status!="ok"}[10m]))', 'sum(rate(llm_requests_total[10m]))') + " > 0.05",
         summary="More than 5% of LLM calls are not ok (10 min)", description="429s, 5xx, timeouts, auth errors and bad JSON all count. See LLM health."),
    dict(uid="ps-alert-rate-limited", title="Rate-limited", severity="warn", window=300, for_="5m",
         expr='sum(rate(llm_requests_total{status="429"}[5m])) > 0', summary="Ollama Cloud is returning 429 (5 min sustained)", description="Consider the fallback chain or a higher plan tier (decision D4)."),
    dict(uid="ps-alert-fallback-in-use", title="Fallback in use", severity="warn", window=1800, for_="30m",
         expr=_ratio("sum(rate(llm_fallback_total[30m]))", "sum(rate(llm_requests_total[30m]))") + " > 0.2", summary="More than 20% of calls fall back to another model (30 min)",
         description="The primary model is failing often enough that the fallback chain is carrying real traffic."),
    dict(uid="ps-alert-cloud-budget", title="Cloud GPU budget", severity="warn", window=300, for_="5m",
         expr="sum(increase(llm_gpu_seconds_total[7d])) > 0.8 * ${LLM_WEEKLY_GPU_SECONDS_BUDGET}", summary="Weekly GPU-seconds above 80% of budget",
         description="Budget comes from LLM_WEEKLY_GPU_SECONDS_BUDGET (observability/.env). The shipped default is huge on purpose: set it from measured usage."),
    dict(uid="ps-alert-weekly-run-missed", title="Weekly run missed", severity="page", window=300, for_="5m",
         expr="time() - max by (screener_job) (last_over_time(screener_job_last_success_timestamp[30d])) > 8 * 86400", no_data="Alerting", summary="A weekly job has not recorded a good result for 8 days",
         description="Per screener_job (weekly_select, forward_test, flag_matrix, threshold_experiment), from the record files via scripts/emit_job_metrics.py. No data at all also alerts: it means the job has never reported (or telemetry is not reaching Grafana Cloud)."),
    dict(uid="ps-alert-accuracy-regression", title="Interpreter accuracy regression", severity="warn", window=300, for_="0s",
         expr="0.97 - min by (provider, model) (last_over_time(golden_suite_accuracy[30d])) > 0", summary="golden_suite_accuracy fell below the 97% target", description="Latest pushed eval result for this provider/model is under 0.97."),
    dict(uid="ps-alert-price-data-broken", title="Price data broken", severity="warn", window=900, for_="10m",
         expr=_ratio("sum(rate(data_fetch_errors_total[15m]))", "sum(rate(data_fetch_symbols_total[15m]))") + " > 0.1", summary="More than 10% of symbol fetches are failing",
         description="Yahoo / NSE / Google data-fetch error ratio. See Screener jobs & data."),
    dict(uid="ps-alert-agent-failing", title="Agent failing", severity="warn", window=1800, for_="30m",
         expr=_ratio('sum by (agent) (rate(agent_invocations_total{status="error"}[30m]))', "sum by (agent) (rate(agent_invocations_total[30m]))") + " > 0.1",
         summary="An agent's error rate is above 10% (30 min)", description="Per agent label. Open the Run explorer for the failing calls."),
    dict(uid="ps-alert-tool-failing", title="Tool failing", severity="warn", window=1800, for_="30m",
         expr=_ratio('sum by (tool) (rate(tool_calls_total{status="error"}[30m]))', 'sum by (tool) (rate(tool_calls_total{status!="skipped"}[30m]))') + " > 0.1",
         summary="A tool's error rate is above 10% (30 min)", description="Per tool label. Skipped calls (routine 'provider has nothing') are excluded."),
]


def build() -> dict[str, str]:
    out = {f"grafana/dashboards/{name}.json": json.dumps(fn().render(), indent=2) + "\n" for name, fn in DASHBOARDS.items()}
    return out


def main() -> int:
    for rel, content in build().items():
        path = ROOT / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        print("wrote", path.relative_to(ROOT.parent))
    return 0


if __name__ == "__main__":
    sys.exit(main())
