"""M2 done-when: the 'Nifty 100 SMA crossover' prompt runs end to end, with niftyindices reachable and down."""
from __future__ import annotations

import pandas as pd

from engine.app import context_from_env
from engine.resolution.universe import build_universe_resolver
from engine.v5.run import run_program
from tests.engine.test_v5_engine import ind, prog

C = {"id": "C1", "lhs": ind("sma", length=6, source="close"), "op": "cross_any",
     "rhs": ind("sma", length=30, source="close"), "within_bars": None}
UNI = {"source": "index", "index": "NIFTY 100"}
AS_OF = "2026-09-25"


def _ctx(literal_env, tmp_path, fetcher, network=True):
    ctx = context_from_env(literal_env, offline=True)
    ctx = type(ctx)(**{**ctx.__dict__, "_cache": {}})          # fresh copy; do not mutate the shared one
    ctx.index_snapshot_dir = str(tmp_path)
    ctx.universe_resolver = build_universe_resolver(cache_dir=tmp_path, network=network, fetcher=fetcher, sleep=lambda s: None)
    return ctx


def test_runs_with_niftyindices_reachable(literal_env, tmp_path):
    tickers = list(literal_env.daily_panels)[:100]
    body = "Company Name,Industry,Symbol\n" + "".join(f"n,x,{t[:-3]}\n" for t in tickers)
    out = run_program(prog([C], universe=UNI), AS_OF, _ctx(literal_env, tmp_path, lambda u, t: body.encode()))
    assert out["universe"]["count"] == 100 and out["universe"]["quality"] == "ok"


def test_runs_with_niftyindices_down_via_approximation(literal_env, tmp_path):
    def down(u, t): raise OSError("down")
    out = run_program(prog([C], universe=UNI), AS_OF, _ctx(literal_env, tmp_path, down))
    u = out["universe"]
    assert u["quality"] == "approx" and u["reason"] == "approx_input" and u["count"] == 100
    assert "top 100 by mcap" in u["approximation"]
