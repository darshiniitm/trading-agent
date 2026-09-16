"""
Regenerate the threshold-experiment section (§04d) of docs/dashboards/test-vs-control-ledger.html
from an already-graded results/threshold_experiment/threshold_<week>.json record.

Only reads data that track_threshold.py already computed (per HARNESS §12: every arm is
derived from Control's own graded picks, never a second price/screen read) and never touches
anything outside the THRESHOLD_SECTION:BEGIN/END markers in the dashboard file.

Usage:
    python3 -m scripts.rebuild_threshold_dashboard_section [--record path/to/threshold_<wk>.json]

With no --record, uses the most recently created threshold_*.json in results/threshold_experiment/.
Refuses (no-op, exit 0) if that record's `graded` block is still null — nothing to render yet.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.experiments import threshold as tx  # noqa: E402

DASHBOARD = ROOT / "docs" / "dashboards" / "test-vs-control-ledger.html"
RESULTS_DIR = ROOT / "results" / "threshold_experiment"
BEGIN = "<!-- THRESHOLD_SECTION:BEGIN"
END = "<!-- THRESHOLD_SECTION:END -->"


def latest_record_path() -> Path | None:
    candidates = sorted(RESULTS_DIR.glob("threshold_*.json"))
    return candidates[-1] if candidates else None


def fmt_pct(v, signed: bool = False) -> str:
    if v is None:
        return "&mdash;"
    sign = "+" if signed and v > 0 else ""
    return f"{sign}{v:.2f}%"


def pct_class(v) -> str:
    if v is None:
        return ""
    return "pos" if v > 0 else ("neg" if v < 0 else "")


def group_consecutive(caps: list[float], arms: dict, exp: str) -> list[dict]:
    """Collapse consecutive caps whose SELECTED set is identical into one display row,
    mirroring how the dashboard already treats T1-sibling-identical arms."""
    groups: list[dict] = []
    for c in caps:
        name = tx.arm_name(c, exp)
        sel = tuple(arms[name]["selected"])
        if groups and groups[-1]["selected"] == sel:
            groups[-1]["caps"].append(c)
        else:
            groups.append({"caps": [c], "selected": sel, "arms": [name]})
    for g in groups:
        if len(g["caps"]) > 1:
            g["arms"] = [tx.arm_name(c, exp) for c in g["caps"]]
    return groups


def cap_range_label(caps: list[float]) -> str:
    if len(caps) == 1:
        return f"{tx.cap_label(caps[0])}%"
    return f"{tx.cap_label(caps[0])}% &ndash; {tx.cap_label(caps[-1])}%"


def render_funnel(record: dict, registry: dict, n_survivors: int) -> str:
    exp = registry["experiment"]
    caps = [float(c) for c in registry["caps_pct"]]
    control_cap = float(registry["control_cap_pct"])
    groups = group_consecutive(caps, record["arms"], exp)
    rows = []
    for g in groups:
        n = len(g["selected"])
        width = round(100 * n / n_survivors, 1) if n_survivors else 0
        label = cap_range_label(g["caps"])
        if control_cap in g["caps"]:
            label += " (= Control)"
        final_cls = " final" if n == n_survivors else ""
        extra = ""
        if len(g["caps"]) > 1:
            extra = f' <span class="fdrop" style="color:var(--ink-3)">identical selection across {tx.cap_label(g["caps"][0])}%&ndash;{tx.cap_label(g["caps"][-1])}%</span>'
        rows.append(
            f'      <div class="frow"><div class="flabel">{label}</div><div class="ftrack">'
            f'<div class="fbar{final_cls}" style="width:{width}%"></div></div>'
            f'<div class="fcount">{n}{extra}</div></div>'
        )
    return "\n".join(rows)


def render_outcome_table(record: dict, registry: dict) -> str:
    exp = registry["experiment"]
    caps = [float(c) for c in registry["caps_pct"]]
    control = tx.arm_name(registry["control_cap_pct"], exp)
    per_arm = record["graded"]["per_arm"]
    groups = group_consecutive(caps, record["arms"], exp)
    rows = []
    for g in groups:
        name0 = tx.arm_name(g["caps"][0], exp)
        v = per_arm[name0]
        label = cap_range_label(g["caps"])
        is_ctrl = control in g["arms"]
        arm_pill = ' <span class="pill pill-arm" style="margin-left:4px">= Control</span>' if is_ctrl else ""
        sel_cls = pct_class(v["selected_basket_net_pct"])
        rej_cls = pct_class(v["rejected_basket_net_pct"])
        d_cls = pct_class(v["selected_minus_control_pct"])
        rows.append(
            "        <tr>"
            f'<td class="tick">{label}{arm_pill}</td>'
            f'<td class="n">{v["selected_n"]}</td>'
            f'<td class="n {sel_cls}">{fmt_pct(v["selected_basket_net_pct"], signed=True)}</td>'
            f'<td class="n">{v["rejected_n"]}</td>'
            f'<td class="n {rej_cls}">{fmt_pct(v["rejected_basket_net_pct"], signed=True)}</td>'
            f'<td class="n {d_cls}">{fmt_pct(v["selected_minus_control_pct"], signed=True)}</td>'
            "</tr>"
        )
    return "\n".join(rows)


def render_ticker_table(record: dict, picks_record: dict) -> str:
    detail = {d["ticker"]: d for d in picks_record["graded"].get("detail", [])}
    ordered_rows = sorted(record["rows"], key=lambda r: r["control_status"] != "TRADE")
    rows_out = []
    for r in ordered_rows:
        t = r["ticker"]
        d = detail.get(t)
        if d is None:
            continue
        display_t = t.removesuffix(".NS")
        included = "&mdash;"
        for c in record["caps_pct"]:
            name = tx.arm_name(c, record["experiment"])
            if t in record["arms"][name]["selected"]:
                included = f"{tx.cap_label(c)}%"
                break
        status_pill = (
            '<span class="pill pill-in">TRADE</span>' if r["control_status"] == "TRADE"
            else '<span class="pill pill-out">SHADOW &middot; risk cap</span>'
        )
        row_cls = "" if r["control_status"] == "TRADE" else ' class="out"'
        net_cls = pct_class(d["ret_pct_net"])
        rows_out.append(
            f"        <tr{row_cls}><td class=\"tick\">{display_t}</td><td>{status_pill}</td>"
            f'<td class="n">{d["EP_actual"]:.2f}</td><td class="n">{d["exit_price"]:.2f}</td>'
            f'<td>{d["exit_reason"]}</td><td class="n">{d["ret_pct"]:.2f}%</td>'
            f'<td class="n {net_cls}">{fmt_pct(d["ret_pct_net"], signed=True)}</td>'
            f'<td class="n">{d["r_multiple"] if d["r_multiple"] is not None else "&mdash;"}</td>'
            f'<td class="n">{included}</td></tr>'
        )
    return "\n".join(rows_out)


def render_section(record: dict, picks_record: dict, registry: dict) -> str:
    exp = registry["experiment"]
    control = tx.arm_name(registry["control_cap_pct"], exp)
    graded = record["graded"]
    per_arm = graded["per_arm"]
    n_survivors = sum(1 for r in record["rows"] if r["r_pct"] is not None)
    week = record["signal_week"]
    mode = record["recording_mode"]
    mode_pill = "pill-in" if mode == "forward" else "pill-flag"
    checks_ok = all(c["status"] == "PASS" for c in graded["checks"] + record["checks"])
    checks_pill = ("pill-in", "all checks pass") if checks_ok else ("pill-out", "CHECK FAILURE — see checks[]")

    best = max(per_arm.items(), key=lambda kv: (kv[1]["selected_minus_control_pct"] or 0))
    worst = min(per_arm.items(), key=lambda kv: (kv[1]["selected_minus_control_pct"] or 0))

    lines = []
    lines.append(
        f'  <div class="step-head"><span class="step-n">04d</span><h2>Threshold experiment &mdash; '
        f'risk-cap sweep<span class="pill {mode_pill}" style="margin-left:6px">graded &middot; {mode}, '
        f'week of {week}</span></h2></div>'
    )
    lines.append(
        '  <p class="lede">Registered 15 Sep 2026 (<code>docs/threshold-experiment-plan.md</code>). '
        f'Eight shadow arms &mdash; <code>{exp}_15/17.5/20/22.5/25/30/40/50</code> &mdash; each a fixed '
        f're-split of Control\'s <strong>same</strong> week\'s survivors by risk-cap headroom (<code>R/EP</code>), '
        'graded off Control\'s own gap-aware exit &mdash; never a second price read. '
        f'<span class="pill {checks_pill[0]}" style="margin-left:2px">{checks_pill[1]}</span></p>'
    )

    lines.append('  <div class="card" style="margin-bottom:20px">')
    lines.append(
        f'    <div class="card-head">Selected count by cap &mdash; week of {week}'
        f'<span class="side">{n_survivors} survivors with a usable stop</span></div>'
    )
    lines.append('    <div class="funnel">')
    lines.append(render_funnel(record, registry, n_survivors))
    lines.append('    </div>')
    lines.append('  </div>')

    lines.append('  <div class="card" style="margin-bottom:20px">')
    lines.append(
        f'    <div class="card-head">Per-arm outcome &mdash; week of {week}'
        f'<span class="side">equal-weight net, SELECTED vs. REJECTED</span></div>'
    )
    lines.append('    <div class="scroll"><table>')
    lines.append(
        '      <thead><tr><th>Cap</th><th>Selected n</th><th>Selected net</th>'
        '<th>Rejected n</th><th>Rejected net</th><th>&Delta; vs Control</th></tr></thead>'
    )
    lines.append('      <tbody>')
    lines.append(render_outcome_table(record, registry))
    lines.append('      </tbody>')
    lines.append('    </table></div>')
    lines.append(
        '    <div style="padding:10px 18px;font-size:12.5px;color:var(--ink-3);border-top:1px solid var(--rule)">'
        f'<code>{control}</code>\'s SELECTED basket equals Control\'s own graded '
        f'<code>basket_net_pct</code> (invariant X6). n=1 week per arm &mdash; not a read, see callout below.</div>'
    )
    lines.append('  </div>')

    lines.append('  <div class="card">')
    lines.append(
        f'    <div class="card-head">Every survivor, graded &mdash; week of {week}'
        '<span class="side">from Control\'s own graded.detail</span></div>'
    )
    lines.append('    <div class="scroll"><table>')
    lines.append(
        '      <thead><tr><th>Ticker</th><th>Control status</th><th>Entry (open)</th><th>Exit px</th>'
        '<th>Exit reason</th><th>Gross</th><th>Net</th><th>R mult.</th><th>Included from cap &ge;</th></tr></thead>'
    )
    lines.append('      <tbody>')
    lines.append(render_ticker_table(record, picks_record))
    lines.append('      </tbody>')
    lines.append('    </table></div>')
    lines.append('  </div>')

    callout_cls = "callout" if mode == "forward" else "callout pend"
    lines.append(f'  <div class="{callout_cls}">')
    lines.append(f'    <h3>First graded threshold week &mdash; n=1, not a read</h3>')
    lines.append(
        '    <p>'
        f'Best arm this week: <strong>{best[0].replace(exp + "_", "")+"%"}</strong> '
        f'({fmt_pct(best[1]["selected_minus_control_pct"], signed=True)} vs. Control). '
        f'Worst: <strong>{worst[0].replace(exp + "_", "")+"%"}</strong> '
        f'({fmt_pct(worst[1]["selected_minus_control_pct"], signed=True)} vs. Control). '
        + ("This is a <strong>late_backfill</strong> record &mdash; it does not count toward the 13/26-week gate. "
           if mode != "forward" else
           "This is the first <strong>forward</strong> week toward the 13-week first look (~mid Dec 2026) "
           "and the 26-week kill/graduation gate (~mid Mar 2027). ")
        + 'Per plan &sect;1 D5/registration: one week decides nothing in either direction &mdash; '
          'no arm is judged, killed, or graduated on this evidence alone.'
        '</p>'
    )
    lines.append('  </div>')

    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--record", type=Path, default=None,
                     help="path to threshold_<week>.json (default: latest in results/threshold_experiment/)")
    args = ap.parse_args()

    record_path = args.record or latest_record_path()
    if record_path is None:
        print("no threshold_*.json records found in results/threshold_experiment/ — nothing to render.")
        return 0

    record = json.loads(record_path.read_text())
    if not record.get("graded"):
        print(f"{record_path.name}: not graded yet (graded=null) — run "
              f"'python3 -m tests.track_threshold grade --all-pending' after Control's own week is graded, "
              f"then re-run this script. Dashboard left unchanged.")
        return 0

    registry = tx.load_registry()
    picks_record = json.loads(Path(record["picks_file"]).read_text())
    if not picks_record.get("graded"):
        print(f"{record['picks_file']}: Control's own picks record isn't graded — inconsistent with "
              f"{record_path.name} having a graded block. Refusing to render. Dashboard left unchanged.")
        return 1

    new_inner = render_section(record, picks_record, registry)

    html = DASHBOARD.read_text()
    pattern = re.compile(re.escape(BEGIN) + r".*?" + re.escape(END), re.DOTALL)
    if not pattern.search(html):
        print(f"THRESHOLD_SECTION markers not found in {DASHBOARD} — refusing to guess where to write. "
              f"Restore the markers (see docs/dashboards/test-vs-control-ledger.html around §04d) and re-run.")
        return 1

    replacement = f"{BEGIN} — regenerate with scripts/rebuild_threshold_dashboard_section.py, do not hand-edit below -->\n{new_inner}\n{END}"
    html = pattern.sub(lambda _m: replacement, html, count=1)
    DASHBOARD.write_text(html)
    print(f"Rebuilt §04d from {record_path.name} (signal week {record['signal_week']}, mode={record['recording_mode']}).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
