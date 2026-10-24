"""Grafana Cloud setup for the prompt-screener (docs/production-llm-cloud-observability-plan.md, Part B).

    python -m observability.cloud check                    # test the OTLP credentials (traces/metrics/logs) and the service-account token
    python -m observability.cloud headers                  # build OTEL_EXPORTER_OTLP_HEADERS from your OTLP instance id + token
    python -m observability.cloud sync                     # DRY RUN: show what would be created / updated
    python -m observability.cloud sync --apply             # create / update the folder, Postgres datasource, 6 dashboards,
                                                           #   10 alert rules and a placeholder webhook contact point
          [--policies]    also replace the stack's notification policy tree (off by default: it overwrites existing routing)
          [--no-postgres] leave the Supabase datasource (and its panels' data) out

Reads GRAFANA_URL and GRAFANA_SA_TOKEN (a service-account token with Editor rights, plus Admin if you want the datasource and the
alert provisioning API) from the environment or observability/.env. Nothing is sent without --apply. Tokens and passwords are never
printed. Everything is idempotent: re-running updates in place. Nothing here has been run against a real stack yet.
"""
from __future__ import annotations

import argparse
import base64
import copy
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

from observability import build as ob

# read in this order (later wins; real environment variables win over both)
DEFAULT_ENV_FILES = [Path(__file__).resolve().parents[1] / ".env", Path(__file__).resolve().parent / ".env"]
FOLDER_UID, FOLDER_TITLE, RULE_GROUP = "prompt-screener", "Prompt Screener", "prompt-screener"
CONTACT_NAME, CONTACT_UID = "prompt-screener-webhook", "ps-contact-webhook"
DS_TYPES = {"prometheus", "loki", "tempo"}
LOGICAL = ("prom", "loki", "tempo")


class SyncError(RuntimeError):
    pass


def otlp_headers_line(env) -> str:
    inst, tok = env.get("GRAFANA_OTLP_INSTANCE_ID"), env.get("GRAFANA_OTLP_TOKEN")
    if not inst or not tok:
        raise SystemExit("set GRAFANA_OTLP_INSTANCE_ID and GRAFANA_OTLP_TOKEN (Grafana Cloud > your stack > OpenTelemetry > Configure)")
    return "OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic%20" + base64.b64encode(f"{inst}:{tok}".encode()).decode()


def load_env_file(path: str | Path) -> dict[str, str]:
    out: dict[str, str] = {}
    p = Path(path)
    if not p.exists():
        return out
    for line in p.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip("\"'")
    return out


# ---- payload builders (pure) ------------------------------------------------------------------------------------------------
def remap_dashboard(dash: dict, mapping: dict[str, str]) -> dict:
    """Swap the logical datasource uids (prom / loki / tempo) for the stack's real ones, in panel/variable references AND inside the
    URL-encoded Explore links of the table panels."""
    def walk(n):
        if isinstance(n, dict):
            if n.get("uid") in mapping and n.get("type") in DS_TYPES:
                n = {**n, "uid": mapping[n["uid"]]}
            return {k: walk(v) for k, v in n.items()}
        if isinstance(n, list):
            return [walk(x) for x in n]
        if isinstance(n, str) and "%22" in n:
            return re.sub(r"%22(prom|loki|tempo)%22", lambda m: f"%22{mapping.get(m.group(1), m.group(1))}%22", n)
        return n
    return walk(copy.deepcopy(dash))


def _expand(expr: str, env) -> str:
    return re.sub(r"\$\{([A-Z0-9_]+)\}", lambda m: env.get(m.group(1), "1000000000" if m.group(1) == "LLM_WEEKLY_GPU_SECONDS_BUDGET" else m.group(0)), expr)


def alert_payloads(mapping: dict[str, str], folder_uid: str, env) -> list[dict]:
    out = []
    for r in ob.RULES:
        out.append({
            "uid": r["uid"], "title": r["title"], "ruleGroup": RULE_GROUP, "folderUID": folder_uid, "condition": "C", "for": r["for_"],
            "noDataState": r.get("no_data", "OK"), "execErrState": "Error", "isPaused": False,
            "annotations": {"summary": r["summary"], "description": r["description"]}, "labels": {"severity": r["severity"], "stack": "prompt-screener"},
            "data": [
                {"refId": "A", "relativeTimeRange": {"from": r["window"], "to": 0}, "datasourceUid": mapping.get("prom", "prom"),
                 "model": {"refId": "A", "expr": _expand(r["expr"], env), "instant": True, "intervalMs": 1000, "maxDataPoints": 43200}},
                {"refId": "B", "datasourceUid": "__expr__", "model": {"refId": "B", "type": "reduce", "expression": "A", "reducer": "last", "settings": {"mode": "dropNN"}}},
                {"refId": "C", "datasourceUid": "__expr__", "model": {"refId": "C", "type": "threshold", "expression": "B", "conditions": [{"evaluator": {"type": "gt", "params": [0]}}]}},
            ]})
    return out


def _pick(items: list[dict], dtype: str, prefer: str) -> str | None:
    cands = [d for d in items if d.get("type") == dtype and not re.search(r"usage|ml-|alert-state|insights", d.get("uid", "") + d.get("name", ""), re.I)]
    cands.sort(key=lambda d: (prefer not in (d.get("uid", "") + d.get("name", "")), not d.get("isDefault", False)))
    return cands[0]["uid"] if cands else None


# ---- credentials check (the scripted version of Grafana's wizard curl) -----------------------------------------------------------
@dataclass
class Check:
    name: str
    status: int | None
    ok: bool
    verdict: str


def _default_session():
    import requests
    return requests.Session()


def endpoint_problem(endpoint: str) -> str | None:
    """A Grafana Cloud gateway host is otlp-gateway-<zone>.grafana.net with a non-empty zone (e.g. prod-us-central-0). Other hosts are not judged."""
    from urllib.parse import urlparse
    host = (urlparse(endpoint).hostname or "").lower()
    if host.endswith(".grafana.net") and host.startswith("otlp-gateway"):
        zone = host[len("otlp-gateway-"):-len(".grafana.net")] if host.startswith("otlp-gateway-") else ""
        if not zone or zone.endswith("-") or not re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)+", zone):
            return (f"endpoint host '{host}' has no valid region/zone: copy the full endpoint from Grafana Cloud > your stack > OpenTelemetry > Configure "
                    "(it looks like https://otlp-gateway-prod-<region>.grafana.net/otlp)")
    return None


def _otlp_verdict(code: int, signal: str) -> str:
    if code in (200, 201, 202, 204):
        return "ok"
    return {530: "gateway host does not exist (Cloudflare 530): the region/zone in OTEL_EXPORTER_OTLP_ENDPOINT is probably wrong or missing",
            401: "rejected: wrong instance ID or token", 403: f"token lacks the {signal}:write scope", 404: "not found: does OTEL_EXPORTER_OTLP_ENDPOINT end with /otlp?",
            429: "rate limited, try again shortly"}.get(code, "Grafana server error, try again" if code >= 500 else f"unexpected HTTP {code}")


def _otlp_authorization(env) -> str | None:
    """Separate instance id + token win; otherwise the Authorization value from OTEL_EXPORTER_OTLP_HEADERS (what the app itself sends)."""
    inst, tok = env.get("GRAFANA_OTLP_INSTANCE_ID"), env.get("GRAFANA_OTLP_TOKEN")
    if inst and tok:
        return "Basic " + base64.b64encode(f"{inst}:{tok}".encode()).decode()
    from urllib.parse import unquote
    for part in (env.get("OTEL_EXPORTER_OTLP_HEADERS") or "").split(","):
        k, _, v = part.partition("=")
        if k.strip().lower() == "authorization" and v.strip():
            val = re.sub(r"^(\S+)\s+", r"\1 ", unquote(v.strip()))     # tolerate a stray space after `Basic%20`, like the app does
            return val if len(val.split(" ", 1)) == 2 and val.split(" ", 1)[1].strip() else None     # "Basic " with nothing after it is not a credential
    return None


def check_credentials(env, session=None, timeout: float = 15.0) -> list[Check]:
    """POST an empty (valid) OTLP payload to each signal and GET /api/org with the service-account token. Stores nothing, prints no secret:
    verdicts name only the cause, and exceptions are reported by type, never by message."""
    s = session or _default_session()
    out: list[Check] = []
    auth = _otlp_authorization(env)
    need = [k for k in ("OTEL_EXPORTER_OTLP_ENDPOINT",) if not env.get(k)]
    if auth is None:
        need.append("GRAFANA_OTLP_INSTANCE_ID + GRAFANA_OTLP_TOKEN (or OTEL_EXPORTER_OTLP_HEADERS)")
    bad_endpoint = None if need else endpoint_problem(env["OTEL_EXPORTER_OTLP_ENDPOINT"])
    for signal in ("traces", "metrics", "logs"):
        name = f"OTLP {signal}"
        if bad_endpoint:
            out.append(Check(name, None, False, bad_endpoint))
            continue
        if need:
            out.append(Check(name, None, False, "not set: " + ", ".join(need)))
            continue
        url = f"{env['OTEL_EXPORTER_OTLP_ENDPOINT'].rstrip('/')}/v1/{signal}"
        try:
            r = s.request("POST", url, json={}, headers={"Authorization": auth, "Content-Type": "application/json"}, timeout=timeout)
            out.append(Check(name, r.status_code, r.status_code in (200, 201, 202, 204), _otlp_verdict(r.status_code, signal)))
        except Exception as exc:                                         # noqa: BLE001
            out.append(Check(name, None, False, f"unreachable: {type(exc).__name__}"))
    missing = [k for k in ("GRAFANA_URL", "GRAFANA_SA_TOKEN") if not env.get(k)]
    if missing:
        out.append(Check("Grafana API (service account)", None, False, "not set: " + ", ".join(missing)))
    else:
        try:
            r = s.request("GET", env["GRAFANA_URL"].rstrip("/") + "/api/org", headers={"Authorization": f"Bearer {env['GRAFANA_SA_TOKEN']}", "Content-Type": "application/json"}, timeout=timeout)
            verdict = {200: "ok", 401: "token is invalid or expired", 403: "service account needs the Admin role (dashboards, datasources, alert rules)"}.get(
                r.status_code, "Grafana server error, try again" if r.status_code >= 500 else f"unexpected HTTP {r.status_code}")
            out.append(Check("Grafana API (service account)", r.status_code, r.status_code == 200, verdict))
        except Exception as exc:                                         # noqa: BLE001
            out.append(Check("Grafana API (service account)", None, False, f"unreachable: {type(exc).__name__}"))
    return out


def format_check(results: list[Check]) -> list[str]:
    return [f"{'OK ' if r.ok else 'FAIL'}  {r.name:<30} {r.status if r.status is not None else '-':>4}  {r.verdict}" for r in results]


# ---- the API client ----------------------------------------------------------------------------------------------------------
class GrafanaCloud:
    def __init__(self, base_url: str, token: str, session=None, timeout: float = 30.0):
        self.base, self.token, self.timeout = base_url.rstrip("/"), token, timeout
        if session is None:
            import requests
            session = requests.Session()
        self.s = session

    def _scrub(self, text: str) -> str:
        return text.replace(self.token, "[redacted]") if self.token else text

    def _req(self, method, path, body=None, extra=None, allow=(404,)):
        headers = {"Authorization": f"Bearer {self.token}", "Content-Type": "application/json", **(extra or {})}
        r = self.s.request(method, self.base + path, json=body, headers=headers, timeout=self.timeout)
        if r.status_code >= 400 and r.status_code not in allow:
            raise SyncError(f"{method} {path} -> {r.status_code}: {self._scrub(str(r.text))[:300]}")
        return r

    def discover_datasources(self) -> dict[str, str]:
        r = self._req("GET", "/api/datasources")
        items = r.json() if isinstance(r.json(), list) else []
        found = {"prom": _pick(items, "prometheus", "prom"), "loki": _pick(items, "loki", "logs"), "tempo": _pick(items, "tempo", "traces")}
        missing = [k for k, v in found.items() if not v]
        if missing:
            raise SyncError(f"no {', '.join(missing)} datasource found on this stack (expected the built-in grafanacloud-* ones)")
        return found  # type: ignore[return-value]

    def _exists(self, path: str) -> bool:
        return self._req("GET", path).status_code == 200

    def sync(self, env, apply: bool = False, policies: bool = False, postgres: bool = True) -> list[str]:
        log = [("APPLY: changing " if apply else "DRY RUN: nothing will be changed on ") + self.base.split("//")[-1]]
        mapping = self.discover_datasources()
        log.append(f"datasources: prom={mapping['prom']} loki={mapping['loki']} tempo={mapping['tempo']}")
        dashboards = {name: remap_dashboard(fn().render(), mapping) for name, fn in ob.DASHBOARDS.items()}
        rules = alert_payloads(mapping, FOLDER_UID, env)

        pg_ok = postgres and all(env.get(k) for k in ("GRAFANA_PG_HOST", "GRAFANA_PG_DATABASE", "GRAFANA_PG_USER", "GRAFANA_PG_PASSWORD"))
        log.append(f"folder: {FOLDER_TITLE} ({FOLDER_UID})")
        log.append("Postgres datasource (supabase, read-only grafana_ro): " + ("will be created/updated" if pg_ok else "skipped (--no-postgres)" if not postgres else "skipped: set GRAFANA_PG_HOST/DATABASE/USER/PASSWORD"))
        log.append(f"{len(dashboards)} dashboards, {len(rules)} alert rules, contact point {CONTACT_NAME!r} -> placeholder webhook" + ("; notification policy REPLACED" if policies else ""))
        if not apply:
            return log

        if not self._exists(f"/api/folders/{FOLDER_UID}"):
            self._req("POST", "/api/folders", {"uid": FOLDER_UID, "title": FOLDER_TITLE})
        if pg_ok:
            body = {"uid": "supabase", "name": "Supabase (runs)", "type": "grafana-postgresql-datasource", "access": "proxy", "url": env["GRAFANA_PG_HOST"], "user": env["GRAFANA_PG_USER"],
                    "jsonData": {"database": env["GRAFANA_PG_DATABASE"], "sslmode": "require", "postgresVersion": 1500, "timescaledb": False}, "secureJsonData": {"password": env["GRAFANA_PG_PASSWORD"]}}
            if self._exists("/api/datasources/uid/supabase"):
                self._req("PUT", "/api/datasources/uid/supabase", body)
            else:
                self._req("POST", "/api/datasources", body)
        for name, dash in dashboards.items():
            dash["id"] = None
            self._req("POST", "/api/dashboards/db", {"dashboard": dash, "folderUid": FOLDER_UID, "overwrite": True, "message": "synced by observability.cloud"})
        keep_editable = {"X-Disable-Provenance": "true"}
        for rule in rules:
            if self._exists(f"/api/v1/provisioning/alert-rules/{rule['uid']}"):
                self._req("PUT", f"/api/v1/provisioning/alert-rules/{rule['uid']}", rule, keep_editable)
            else:
                self._req("POST", "/api/v1/provisioning/alert-rules", rule, keep_editable)
        cp = {"name": CONTACT_NAME, "type": "webhook", "settings": {"url": env.get("ALERT_WEBHOOK_URL", "https://example.invalid/grafana-alert"), "httpMethod": "POST"}, "disableResolveMessage": False}
        listed = self._req("GET", "/api/v1/provisioning/contact-points").json()
        existing = next((c for c in (listed if isinstance(listed, list) else []) if c.get("name") == CONTACT_NAME), None)
        if existing:
            self._req("PUT", f"/api/v1/provisioning/contact-points/{existing['uid']}", {**cp, "uid": existing["uid"]}, keep_editable)
        else:
            self._req("POST", "/api/v1/provisioning/contact-points", {**cp, "uid": CONTACT_UID}, keep_editable)
        if policies:
            self._req("PUT", "/api/v1/provisioning/policies", {"receiver": CONTACT_NAME, "group_by": ["alertname", "severity"], "group_wait": "30s", "group_interval": "5m", "repeat_interval": "4h",
                                                              "routes": [{"receiver": CONTACT_NAME, "object_matchers": [["severity", "=", "page"]], "repeat_interval": "1h"}]}, keep_editable)
        log.append("done")
        return log


# ---- CLI ---------------------------------------------------------------------------------------------------------------------
def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="observability.cloud", description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("headers", help="print the OTEL_EXPORTER_OTLP_HEADERS line for Grafana Cloud's OTLP gateway")
    sub.add_parser("check", help="test the OTLP credentials (traces / metrics / logs) and the service-account token; prints status codes only")
    sp = sub.add_parser("sync", help="create / update dashboards, alert rules, datasource and contact point (dry run unless --apply)")
    sp.add_argument("--apply", action="store_true")
    sp.add_argument("--policies", action="store_true")
    sp.add_argument("--no-postgres", action="store_true")
    for p in sub.choices.values():
        p.add_argument("--env-file", default=None, help="read only this file (default: repo-root .env, then observability/.env)")
    a = ap.parse_args(argv)
    files = [a.env_file] if a.env_file else DEFAULT_ENV_FILES
    env = {}
    for f in files:
        env.update(load_env_file(f))
    env.update(os.environ)
    if a.cmd == "check":
        results = check_credentials(env, session=_default_session())
        print("\n".join(format_check(results)))
        if all(r.status is None and r.verdict.startswith("not set") for r in results):
            print("nothing to check: fill observability/.env (see observability/GO-LIVE.md)", file=sys.stderr)
            return 2
        return 0 if all(r.ok for r in results) else 1
    if a.cmd == "headers":
        try:
            print(otlp_headers_line(env))
        except SystemExit as exc:
            print(exc, file=sys.stderr)
            return 2
        return 0
    url, tok = env.get("GRAFANA_URL"), env.get("GRAFANA_SA_TOKEN")
    if not (url and tok):
        if a.apply:
            print("sync --apply needs GRAFANA_URL and GRAFANA_SA_TOKEN (environment or observability/.env)", file=sys.stderr)
            return 2
        print("DRY RUN (offline: GRAFANA_URL / GRAFANA_SA_TOKEN not set, so the stack was not contacted)")
        print(f"{len(ob.DASHBOARDS)} dashboards, {len(ob.RULES)} alert rules, contact point {CONTACT_NAME!r}, folder {FOLDER_TITLE!r}")
        print("set GRAFANA_URL and GRAFANA_SA_TOKEN to preview against your stack; add --apply to change it")
        return 0
    try:
        for line in GrafanaCloud(url, tok).sync(env, apply=a.apply, policies=a.policies, postgres=not a.no_postgres):
            print(line)
    except SyncError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
