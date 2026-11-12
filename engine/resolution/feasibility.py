"""Feasibility (spec §6.2-§6.3): which conditions can be fed at all, and a per-condition data status for the chips."""
from __future__ import annotations

from engine.resolution.capabilities import condition_requires, required_data_types
from engine.resolution.types import DataType
from engine.v5.program import ScreenProgram


def _type_available(dt: DataType, ctx) -> bool:
    has_bars = bool(ctx.daily_panels) or bool(ctx.weekly_panels)
    if dt == DataType.OHLCV:
        return has_bars
    if dt == DataType.MCAP:
        return has_bars and bool(ctx.shares)
    if dt == DataType.SECTOR:
        return bool(getattr(ctx, "sector_available", True))
    return True


def unfeedable_ids(program: ScreenProgram, ctx) -> list[str]:
    """Conditions whose required data type has no source at all -> 'not applied: no data source' (never substituted)."""
    return [c.id for c in program.conditions if not all(_type_available(dt, ctx) for dt in required_data_types(c))]


def _quality_of(prov: dict | None) -> tuple[str, str | None]:
    """Worst OHLCV quality across the universe, and the most common non-ok source."""
    order = ["ok", "fallback", "stale", "approx", "missing"]
    worst, src = "ok", None
    for r in (prov or {}).values():
        if order.index(r.quality) > order.index(worst):
            worst, src = r.quality, r.source
    return worst, src


def feasibility(program: ScreenProgram, ctx, universe_meta: dict | None = None) -> dict:
    """Dry-run summary for the interpretation chips. Uses what is already loaded/cached; never downloads."""
    um = universe_meta or {}
    uq = um.get("quality", "ok")
    uni_status = {"status": {"ok": "ready"}.get(uq, uq), "source": um.get("data_source", um.get("source")),
                  "detail": um.get("approximation") or (f"snapshot {um['snapshot']}" if um.get("snapshot") else None)}
    if uq == "missing":
        uni_status["status"] = "unavailable"
    unf = set(unfeedable_ids(program, ctx))
    wq, wsrc = _quality_of(ctx.provenance)
    out = {}
    for c in program.conditions:
        if c.id in unf:
            out[c.id] = {"status": "unavailable", "source": None, "as_of": None, "detail": "no data source"}
            continue
        needs_bars = any(r.startswith("OHLCV") for r in condition_requires(c))
        q = wq if needs_bars else "ok"
        out[c.id] = {"status": "ready" if q == "ok" else q, "source": wsrc if q != "ok" else "cache",
                     "as_of": None, "detail": None}
    return {"universe": uni_status, "conditions": out}


def check_program(program_dict: dict, as_of, ctx, upload: dict | None = None) -> dict:
    """Dry-run feasibility for the interpretation view (spec §6.2): resolves the universe through a short-timeout copy of
    the chain (<= ~3 s, no retries) and reads what is already cached for everything else. Non-blocking by design: a slow
    provider just means that item is reported from the next tier."""
    import dataclasses
    import pandas as pd
    from engine.resolution.config import load_config
    from engine.resolution.resolver import DataResolver
    from engine.resolution.types import DataType
    from engine.v5.universe import UniverseError, approx_mcap, resolve_universe

    program = ScreenProgram.model_validate(program_dict)
    out_universe = {"status": "ready", "source": program.universe.source, "detail": None}
    meta: dict = {"source": program.universe.source}
    if program.universe.source == "index":
        res = ctx.universe_resolver
        if res is not None:
            cfg = load_config()
            cfg["providers"] = {**cfg["providers"], "timeout_s": cfg["ops"]["feasibility_timeout_s"], "retries": 0}
            quick = DataResolver(cfg, gap_log=getattr(res, "_gap_log", None), success_log=getattr(res, "_success_log", None))
            quick.register(DataType.UNIVERSE, res.chain(DataType.UNIVERSE))
            res = quick
        try:
            _, meta = resolve_universe(program.universe.model_dump(by_alias=True), ctx.universe_df, pd.Timestamp(as_of),
                                       ctx.index_snapshot_dir, resolver=res, mcap=lambda: approx_mcap(ctx, pd.Timestamp(as_of)), upload=upload)
        except UniverseError as exc:
            return {"universe": {"status": "unavailable", "source": None, "detail": str(exc), "can_upload": True},
                    "conditions": {c.id: {"status": "unknown", "source": None, "as_of": None, "detail": "universe unavailable"}
                                   for c in program.conditions}}
    ctx2 = dataclasses.replace(ctx, universe_quality=meta.get("quality", "ok"))
    out = feasibility(program, ctx2, meta)
    out["universe"]["can_upload"] = out["universe"]["status"] in ("approx", "unavailable", "stale")
    return out
