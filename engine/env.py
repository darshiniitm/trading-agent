from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Literal

import pandas as pd

from src import telemetry

RULE_SPEC_PATHS = {
    "literal": "config/rules_literal.yaml",
    "t1_literal": "config/rules_literal.yaml",  # same universe/cache as Literal (D1)
}


@dataclass
class Environment:
    rule_spec: dict
    adapter: object
    universe_df: pd.DataFrame
    panels: dict
    shares: dict
    daily_panels: dict | None = None
    provenance: dict | None = None            # ticker -> ResolvedData for daily OHLCV (source, as_of, quality, reason)
    ohlcv_service: object | None = None
    sector_available: bool = True
    mcap_prov: dict | None = None
    gap_log: object | None = None             # engine.resolution.gaplog.GapLog


_CACHE: dict[tuple[str, bool], Environment] = {}
_LOCKS: dict[tuple[str, bool], threading.Lock] = {}
_GUARD = threading.Lock()


@telemetry.tool("engine.load_environment", args_of=lambda structure: {"structure": structure})
def _load_live(structure: str) -> Environment:
    from scripts.common import bootstrap
    from engine.warmup import progress
    rule_spec, adapter, universe_df, panels, shares = bootstrap(RULE_SPEC_PATHS[structure], progress=progress)
    # Daily bars go through the resolver chain (cache -> Yahoo(adapter) -> bhavcopy -> Google -> stale cache). With
    # full data present this returns the adapter's own frames unchanged (tests/engine/resolution regression test).
    from datetime import date
    from engine.resolution.ohlcv import OhlcvService, build_ohlcv_resolver
    history_days = rule_spec["data"]["history_weeks"] * 7
    from engine.resolution.ops import get_gaplog
    gap = get_gaplog(); gap.begin_run()
    resolver, cache, cal = build_ohlcv_resolver(adapter, history_days, gap_log=gap, success_log=gap.success)
    svc = OhlcvService(resolver, cache, cal, gap_log=gap)
    progress("daily_bars")
    daily_panels, prov = svc.daily_panels(list(panels.keys()), date.today())
    # market cap / sector / corporate actions chains (spec §3.4-§3.6): improve on what bootstrap found, never replace it
    from engine.resolution import reference as ref
    progress("reference_data")
    today = date.today()
    close = {t: float(p["close"].dropna().iloc[-1]) for t, p in daily_panels.items() if p["close"].notna().any()}
    more, mprov = ref.resolve_shares(ref.build_mcap_resolver(gap_log=gap), [t for t in panels if t not in shares], today, close)
    shares = {**shares, **more}
    unknown = universe_df.loc[universe_df["sector"].isin(["Unknown", None]), "ticker"].tolist()
    sector_ok = True
    if unknown:
        secs, _ = ref.resolve_sectors(ref.build_sector_resolver(gap_log=gap, known=universe_df.set_index("ticker")["sector"]), unknown, today)
        universe_df = universe_df.copy()
        fill = {t: s for t, s in secs.items() if s != ref.UNCLASSIFIED}
        universe_df["sector"] = [fill.get(t, s) for t, s in zip(universe_df["ticker"], universe_df["sector"])]
    sector_ok = bool((~universe_df["sector"].isin(["Unknown", None])).any())
    ref.annotate_corporate_actions(daily_panels, prov, ref.build_actions_resolver(gap_log=gap), today, None, gap)
    return Environment(rule_spec, adapter, universe_df, panels, shares, daily_panels, prov, svc, sector_ok, mprov, gap)


def _load_offline(structure: str) -> Environment:
    from tests.offline import env_literal
    rule_spec, adapter, universe_df, panels, shares = env_literal()
    daily_panels = adapter.daily_ohlcv(list(panels.keys()), rule_spec["data"]["history_weeks"] * 7)
    return Environment(rule_spec, adapter, universe_df, panels, shares, daily_panels)


def _canonical(structure: str) -> str:
    """Structures that read the same rule spec share one environment (t1_literal is Literal's universe and cache), so
    loading one never repeats the other's minutes-long fetch."""
    return next((k for k, v in RULE_SPEC_PATHS.items() if v == RULE_SPEC_PATHS[structure]), structure)


def load_environment(structure: Literal["literal", "t1_literal"], offline: bool = False) -> Environment:
    key = (_canonical(structure), offline)
    env = _CACHE.get(key)
    if env is not None:
        return env
    # Single flight: requests that arrive while the first one is still loading wait for it instead of loading again
    # (two loaders writing the same cache files at once is what used to corrupt them).
    with _GUARD:
        lock = _LOCKS.setdefault(key, threading.Lock())
    with lock:
        if key not in _CACHE:
            _CACHE[key] = _load_offline(key[0]) if offline else _load_live(key[0])
        return _CACHE[key]


def last_bar_date(env: Environment) -> str | None:
    """The latest date most of the universe has a close for. A week still in progress has bars (open, volume)
    but no close for nearly everyone, and a few stragglers with one do not make it a date a screen can run on."""
    counts: dict[pd.Timestamp, int] = {}
    for p in env.panels.values():
        for d in p.loc[p["close"].notna(), "date"]:
            counts[pd.Timestamp(d)] = counts.get(pd.Timestamp(d), 0) + 1
    need = len(env.panels) / 2
    ok = sorted(d for d, n in counts.items() if n >= need)
    return str(ok[-1].date()) if ok else None
