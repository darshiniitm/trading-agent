"""Stage 2 of the golden end-to-end run: run each compiled program (tests/golden/programs/TCxx.json, written by
frontend scripts/golden-compile.ts) through engine/v5 offline and diff against golden.json.

  python3 tests/golden/run_golden.py [TC01 ...]        # prints a golden-vs-actual table, writes results.json
"""
from __future__ import annotations

import csv
import json
import pandas as pd
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
HERE = Path(__file__).resolve().parent

from engine.env import load_environment
from engine.resolution.universe import build_universe_resolver
from engine.v5.data import DataContext
from engine.v5.run import run_program

PROGRAMS_DIR = HERE / "programs"
SCREEN_DATE = "2026-09-04"
UNIVERSE_SIZE = {"TC10": 200}           # golden.json still holds the old VStop-brief TC10 (368); the doc's TC10 is Ichimoku on Nifty 200
AS_OF = {"TC11": "2026-08-28"}          # the backtest case signals on the Friday before


class TodayMembership:
    """The golden answers apply today's index lists (2026-10-09) to 4 Sep, so index lookups ignore the screen date."""
    def __init__(self, inner, snapshot_date="2026-10-09"):
        self.inner, self.snapshot_date = inner, pd.Timestamp(snapshot_date).date()

    def resolve(self, req):
        import dataclasses
        return self.inner.resolve(dataclasses.replace(req, as_of=self.snapshot_date))

    def __getattr__(self, name):
        return getattr(self.inner, name)


def make_ctx():
    env = load_environment("literal", offline=True)
    b = env.adapter.benchmark_series(env.rule_spec["sector"]["benchmark_ticker"], env.rule_spec["data"]["history_weeks"])
    bench = b[["date", "close"]] if b is not None and not b.empty else None
    return DataContext(env.universe_df, env.shares, env.daily_panels, env.panels, bench, env.rule_spec,
                       index_snapshot_dir="data_cache/index_lists", universe_resolver=TodayMembership(build_universe_resolver(network=False)),
                       provenance=getattr(env, "provenance", None), sector_available=getattr(env, "sector_available", True), gap_log=None)


def bare(t: str) -> str:
    return t[:-3] if t.endswith(".NS") else t


def actual_tickers(result: dict) -> list[str] | None:
    """The stocks a prompt asks for: the last action's output if it ranks/limits/plans, else the last set."""
    acts = result.get("actions") or {}
    for a in reversed(list(acts.values())):
        if a.get("type") in ("rank", "limit") and a.get("rows"):
            return [bare(r["ticker"]) for r in a["rows"]]
        if a.get("type") == "trade_plan" and a.get("plans"):
            return [bare(p["ticker"]) for p in a["plans"]]
    sets = result.get("sets") or {}
    if not sets:
        return None
    last = list(sets)[-1]
    return [bare(m["ticker"]) for m in sets[last]["members"]]


def expected_tickers(case_id: str) -> set[str]:
    """The CSVs are the truth (golden.json's TC10 is the old VStop-brief answer; the doc's TC10 is Ichimoku).
    TC20: nothing is fully qualified (no P/E, ROE source), the 51 technical-only rows are partial matches.
    TC16: the comparison is the outperforming-sector list, handled by the caller."""
    import csv
    if case_id in ("TC20", "TC16"):
        return set()
    return {r["ticker"].replace(".NS", "") for r in csv.DictReader(open(HERE / "expected" / f"{case_id}.csv"))}


def _check_plans(res) -> tuple[bool, str]:
    plans = {bare(p["ticker"]): p for a in res["actions"].values() if a.get("type") == "trade_plan" for p in a["plans"]}
    bad = []
    for r in csv.DictReader(open(HERE / "expected" / "TC17.csv")):
        p = plans.get(r["ticker"])
        for k, g in (("ep", "EP"), ("sl", "SL"), ("target", "target")):
            if p is None or p.get(k) is None or abs(p[k] / float(r[g]) - 1) > 0.005:
                bad.append(f"{r['ticker']}.{k}")
    return not bad, ("values off: " + ", ".join(bad[:6])) if bad else ""


def _check_tc16(row: dict, res: dict) -> dict:
    hl = next((a.get("highlight") for a in res["actions"].values() if a.get("type") == "group_by"), None)
    if not hl or hl.get("status") != "ok":
        row.update(status="NO RESULT", note=str(hl)[:120]); return row
    want_secs = {r["sector"] for r in csv.DictReader(open(HERE / "expected" / "TC16_sectors.csv")) if r["outperforming"] == "True"}
    top = {}
    for r in csv.DictReader(open(HERE / "expected" / "TC16_top3.csv")):
        top.setdefault(r["sector"], []).append(r["ticker"])
    got_secs = {s["sector"] for s in hl["sectors"] if s["outperforming"]}
    got_top = {s["sector"]: [bare(x["ticker"]) for x in s.get("top", [])] for s in hl["sectors"] if s["outperforming"]}
    row.update(golden=len(want_secs), actual=len(got_secs), missing=sorted(want_secs - got_secs), extra=sorted(got_secs - want_secs))
    bad = [s for s in want_secs & got_secs if got_top.get(s) != top.get(s)]
    row["status"] = "PASS" if got_secs == want_secs and not bad else "FAIL"
    row["note"] = f"top-3 differs in {bad}" if bad else ""
    return row


def run_case(ctx, case_id: str, golden: dict) -> dict:
    f = PROGRAMS_DIR / f"{case_id}.json"
    exp = expected_tickers(case_id)
    row = {"id": case_id, "golden": len(exp), "actual": None, "status": "NO PROGRAM", "missing": [], "extra": [], "note": ""}
    if not f.exists():
        return row
    prog = json.loads(f.read_text())
    if "program" not in prog:
        row.update(status="COMPILE ERROR", note=prog.get("error", "")[:160]); return row
    # same as the app's forEngine(): drop the interpreter bookkeeping, keep what could not be evaluated
    p = {k: v for k, v in prog["program"].items() if k not in ("assumptions", "not_evaluable")}
    unsup = [{"text": n["text"], "reason": n["reason"]} for n in prog["program"].get("not_evaluable") or [] if n.get("id") == "unsupported"]
    if unsup:
        p["unsupported"] = unsup
    row["english"] = prog.get("english", "")
    try:
        res = run_program(p, AS_OF.get(case_id, SCREEN_DATE), ctx)
    except Exception as e:                                                      # ProgramError carries .errors
        errs = getattr(e, "errors", None)
        row.update(status="ENGINE REFUSED", note=str(errs or e)[:240]); return row
    sets = res.get("sets") or {}
    last = sets[list(sets)[-1]] if sets else {}
    if case_id == "TC16":
        want_n = golden["cases"][case_id].get("universe_size"); got_n = (res.get("universe") or {}).get("count")
        if p["universe"].get("source") != "index" or (want_n and got_n and abs(got_n - want_n) > 0.1 * want_n):
            row.update(status="FAIL", note=f"universe is {p['universe'].get('source')} / {got_n} stocks, golden used the Nifty 500 ({want_n})"); return row
        return _check_tc16(row, res)
    if last.get("partial"):                       # TC20: unsupported conditions -> nothing is a full match
        part = {bare(m["ticker"]) for m in last["members"]}
        want = {r["ticker"].replace(".NS", "") for r in csv.DictReader(open(HERE / "expected" / f"{case_id}.csv"))}
        row.update(golden=len(want), actual=len(part), fully=last.get("fully_qualified"), missing=sorted(want - part), extra=sorted(part - want),
                   status="PASS" if last.get("fully_qualified") == 0 and part == want else "FAIL",
                   note=f"fully qualified={last.get('fully_qualified')}, partial={len(part)}")
        return row
    # the universe must be the one the prompt names (a pattern that swallowed "in the Nifty 500" once passed by accident)
    want_n = UNIVERSE_SIZE.get(case_id, golden["cases"][case_id].get("universe_size"))
    got_n = (res.get("universe") or {}).get("count")
    if p["universe"].get("source") == "index" and want_n and got_n and abs(got_n - want_n) > 0.1 * want_n:
        row.update(status="FAIL", actual=got_n, note=f"universe has {got_n} stocks, golden used {want_n}"); return row
    got = actual_tickers(res)
    if got is None:
        row.update(status="NO RESULT"); return row
    a = set(got)
    ok = a == exp
    if ok and case_id == "TC12":                  # a ranking: the order matters too
        want = [r["ticker"] for r in csv.DictReader(open(HERE / "expected" / "TC12.csv"))]
        ok = [bare(x) for x in got] == want
        if not ok: row["note"] = "same stocks, wrong order"
    if ok and case_id == "TC17":
        ok, why = _check_plans(res)
        if not ok: row["note"] = why
    row.update(actual=len(a), missing=sorted(exp - a), extra=sorted(a - exp), status="PASS" if ok else "FAIL")
    return row


def main(ids: list[str], programs_dir: Path | None = None):
    global PROGRAMS_DIR
    if programs_dir: PROGRAMS_DIR = programs_dir
    golden = json.loads((HERE / "golden.json").read_text())
    ctx = make_ctx()
    rows = [run_case(ctx, c, golden) for c in sorted(golden["cases"]) if not ids or c in ids]
    (HERE / "results.json").write_text(json.dumps(rows, indent=1))
    print(f"{'ID':5} {'status':15} {'golden':>6} {'actual':>6}  missing / extra")
    for r in rows:
        print(f"{r['id']:5} {r['status']:15} {r['golden']:>6} {str(r['actual']):>6}  -{len(r['missing'])} +{len(r['extra'])} {r['note']}")
    print(f"\n{sum(r['status'] == 'PASS' for r in rows)}/{len(rows)} pass")


if __name__ == "__main__":
    main(sys.argv[1:])
