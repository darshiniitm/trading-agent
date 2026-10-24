"""P6 parity check: our watchlist-view metrics vs the TradingView golden values (plan §6).

    python -m scripts.watchlist_parity          # needs network (Yahoo) and a filled fixture
Writes docs/watchlist-views-parity.md (metric · ours · TradingView · pass/fail · note). Display-only tooling.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "tv_watchlist_2026-10-14.json"
REPORT = ROOT / "docs" / "watchlist-views-parity.md"

# metric -> (kind, tolerance, what to check when it fails)
TOLERANCES = {
    **{k: ("abs", 0.3, "check adjusted vs unadjusted closes, then the 'on or before' date rule") for k in ("perf_1w", "perf_1m", "perf_3m", "perf_ytd", "perf_1y", "perf_5y", "perf_all")},
    "avg_vol_10": ("rel", 0.03, "check session vs consolidated volume (NSE vs NSE+BSE)"),
    "market_cap": ("rel", 0.03, "check session vs consolidated volume / share count source"),
    **{k: ("abs", 0.10, "switch 3Y/5Y to weekly returns; re-test") for k in ("beta_1y", "beta_3y", "beta_5y")},
    **{k: ("abs", 0.15, "switch definition: stdev of returns instead of mean H-L range") for k in ("vol_1d", "vol_1w", "vol_1m")},
    **{k: ("rel", 0.01, "check bar alignment (incomplete bar excluded)") for k in ("rsi14", "cci20", "mom10", "ao")},
    **{k: ("rel", 0.05, "fundamentals lag is expected; document, don't force") for k in ("pe", "eps", "yield")},
}
RATINGS = ("tech_rating", "ma_rating", "os_rating")
RATING_MIN_MATCH = 8   # exact label on >= 8 of 9 symbols


def compare_value(metric: str, ours, theirs) -> tuple[str, str]:
    """-> (verdict, note). verdict is PASS / FAIL / SKIP."""
    if theirs is None:
        return "SKIP", "no TradingView value in the fixture"
    if ours is None:
        return "FAIL", "we produced no value"
    if metric in RATINGS:
        return ("PASS", "") if ours == theirs else ("FAIL", "label differs")
    kind, tol, hint = TOLERANCES[metric]
    diff = abs(ours - theirs) if kind == "abs" else abs(ours - theirs) / abs(theirs) if theirs else abs(ours - theirs)
    unit = "pp/abs" if kind == "abs" else "% of value"
    shown = diff if kind == "abs" else diff * 100
    limit = tol if kind == "abs" else tol * 100
    return ("PASS", f"Δ {shown:.3f} {unit}") if diff <= tol else ("FAIL", f"Δ {shown:.3f} {unit} > {limit:g}; {hint}")


def ratings_gate(results: list[dict]) -> dict:
    out = {}
    for m in RATINGS:
        rows = [r for r in results if r["metric"] == m and r["verdict"] != "SKIP"]
        passed = sum(r["verdict"] == "PASS" for r in rows)
        out[m] = {"checked": len(rows), "passed": passed, "ok": len(rows) > 0 and passed >= min(RATING_MIN_MATCH, len(rows)) if len(rows) >= RATING_MIN_MATCH else None}
    return out


def render_report(results: list[dict], captured_at: str | None, gate: dict) -> str:
    lines = [
        "# Watchlist views — TradingView parity", "",
        f"Golden values captured: {captured_at or 'NOT CONFIRMED (fixture not filled)'}.", "",
        "| Symbol | Metric | Ours | TradingView | Result | Note |", "|---|---|---|---|---|---|",
    ]
    for r in results:
        o = "—" if r["ours"] is None else (f"{r['ours']:.4g}" if isinstance(r["ours"], (int, float)) else r["ours"])
        t = "—" if r["theirs"] is None else (f"{r['theirs']:.4g}" if isinstance(r["theirs"], (int, float)) else r["theirs"])
        lines.append(f"| {r['symbol']} | {r['metric']} | {o} | {t} | {r['verdict']} | {r['note']} |")
    lines += ["", "## Rating labels (exact label on ≥ 8 of 9 symbols)", ""]
    for m, g in gate.items():
        lines.append(f"- {m}: {g['passed']}/{g['checked']} — {'OK' if g['ok'] else 'not enough data to judge' if g['ok'] is None else 'BELOW THRESHOLD'}")
    return "\n".join(lines) + "\n"


def run(fixture_path: Path = FIXTURE, history_fn=None, fundamentals_fn=None) -> tuple[list[dict], dict, str | None]:
    from engine import fundamentals as fund, metrics_service as svc
    fx = json.loads(fixture_path.read_text())
    symbols = {k: v for k, v in fx["symbols"].items() if v.get("values")}
    if not symbols:
        raise SystemExit("fixture has no golden values yet — fill tests/fixtures/tv_watchlist_2026-10-14.json from the screenshots first")
    tickers = [v["yahoo"] for v in symbols.values()]
    ours_all = svc.compute_batch(tickers, "1D", history_fn or svc.default_history)
    funds = (fundamentals_fn or fund.fetch_fundamentals)([t for t in tickers if not t.startswith("^")])
    results = []
    for name, spec in symbols.items():
        t = spec["yahoo"]
        m = ours_all.get(t, {})
        from engine.metrics import rating_label
        f = funds.get(t, {})
        ours = {**m, "market_cap": f.get("market_cap"), "eps": f.get("eps_ttm"),
                "tech_rating": rating_label(m.get("tech_rating")), "ma_rating": rating_label(m.get("ma_rating")), "os_rating": rating_label(m.get("os_rating"))}
        for metric, theirs in spec["values"].items():
            if metric not in TOLERANCES and metric not in RATINGS:
                continue
            verdict, note = compare_value(metric, ours.get(metric), theirs)
            results.append({"symbol": name, "metric": metric, "ours": ours.get(metric), "theirs": theirs, "verdict": verdict, "note": note})
    return results, ratings_gate(results), fx.get("captured_at")


if __name__ == "__main__":
    res, gate, captured = run()
    REPORT.write_text(render_report(res, captured, gate))
    print(f"wrote {REPORT} — {sum(r['verdict'] == 'FAIL' for r in res)} fail / {sum(r['verdict'] == 'PASS' for r in res)} pass")
    sys.exit(0)
