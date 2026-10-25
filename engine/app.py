from __future__ import annotations

import hmac
import os
from contextlib import asynccontextmanager
from pathlib import Path

import pandas as pd
from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from engine.arms import is_active, register_arm, retire_arm
from engine.env import load_environment
from engine.forward_record import write_record
from engine.health import health_payload
from engine.resolution.universe import build_universe_resolver
from engine.quotes import fetch_quotes, series_payload
from engine import fundamentals as _fundamentals, metrics_service as _metrics_service, refresh as _refresh
from engine.v5.data import DataContext
from engine.v5.evaluator import ProgramError
from engine.v5.legacy import ValidationSpecError, screen_legacy, select_legacy, structure_of, validate_legacy
from engine.v5.registry import conditions_payload
from engine.v5.run import run_program
from engine.warmup import STATE as WARM
from engine import watchdog
from src import telemetry

_CTX: dict[int, DataContext] = {}


def env_gap(env):
    from engine.resolution.ops import get_gaplog
    return getattr(env, "gap_log", None) or get_gaplog()


def context_from_env(env, offline: bool = False) -> DataContext:
    """One DataContext per loaded environment, so its resampled-bar cache survives across requests."""
    if id(env) in _CTX:
        return _CTX[id(env)]
    bench = None
    if env.adapter is not None:
        try:
            ticker = env.rule_spec.get("sector", {}).get("benchmark_ticker", "")
            b = env.adapter.benchmark_series(ticker, env.rule_spec["data"]["history_weeks"])
            bench = b[["date", "close"]] if b is not None and not b.empty else None
        except Exception:
            bench = None
    _CTX[id(env)] = DataContext(env.universe_df, env.shares, env.daily_panels, env.panels, bench, env.rule_spec,
                                index_snapshot_dir="data_cache/index_lists",
                                universe_resolver=build_universe_resolver(network=not offline, **({} if offline else {"gap_log": env_gap(env), "success_log": env_gap(env).success})),
                                provenance=getattr(env, "provenance", None), sector_available=getattr(env, "sector_available", True),
                                gap_log=None if offline else env_gap(env))
    return _CTX[id(env)]


def with_upload(ctx: DataContext, user_id: int | None, prompt_id: int | None) -> DataContext:
    """Tier-0 user uploads are keyed by user and prompt (spec §9.4); without both ids there is no upload to look for."""
    if user_id is None or prompt_id is None:
        return ctx
    import dataclasses
    return dataclasses.replace(ctx, upload={"user_id": user_id, "prompt_id": prompt_id})


def _unprocessable(exc: ProgramError) -> HTTPException:
    return HTTPException(status_code=422, detail=[{"condition_id": e.get("id"), "message": e["message"]} for e in exc.errors])


def _warm_literal() -> None:
    from engine.warmup import progress
    env = load_environment("literal")
    # Build the per-stock bar indexes now (the same DataContext requests use), so the first screen is as fast as the rest.
    progress("indexes")
    context_from_env(env).prime(progress=lambda d, t: progress("indexes", d, t))


def create_app(offline: bool = False, history_fn=None, fundamentals_fn=None,
               refresh_cache_dir=None, refresh_weeks: int | None = None, refresh_runner=None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        watchdog.start_from_env()           # exit if the app that started us dies (ENGINE_PARENT_PID)
        if not offline:
            WARM.start(_warm_literal)       # load market data once, in the background, so requests never race to do it
        yield

    app = FastAPI(title="prompt-screener-engine", lifespan=lifespan)
    # observability (docs/production-llm-cloud-observability-plan.md): env-driven, a no-op unless OTEL_EXPORTER_OTLP_ENDPOINT or
    # TELEMETRY_DB_URL / SUPABASE_DB_URL is set. Joins the TS app's trace via `traceparent` and binds its run via `x-run-id`.
    telemetry.init("prompt-screener-engine")
    telemetry.install_fastapi(app)

    # Bearer-token gate for a deployed engine (docs/netlify-production-plan.md §5.2). Off when ENGINE_TOKEN is unset, so the
    # local engine on 127.0.0.1 behaves exactly as before. /health stays open for the host's own probes; it holds no data.
    @app.middleware("http")
    async def require_engine_token(request: Request, call_next):
        token = os.environ.get("ENGINE_TOKEN", "")
        if token and request.url.path != "/health":
            supplied = request.headers.get("authorization", "")
            if not (supplied.startswith("Bearer ") and hmac.compare_digest(supplied[7:].encode(), token.encode())):
                return JSONResponse({"detail": "engine token required"}, status_code=401)
        return await call_next(request)

    def require_ready() -> None:
        """Requests that need market data get a clear 503 while it loads (with what it is doing), never a 500."""
        if offline:
            return
        snap = WARM.snapshot()
        if snap["state"] == "ready":
            return
        if snap["state"] == "starting":     # a host that skipped the lifespan (e.g. a bare TestClient): start loading now
            WARM.start(_warm_literal)
            snap = WARM.snapshot()
        raise HTTPException(status_code=503, detail={"engine": snap}, headers={"Retry-After": "3"})

    def env_for(program: dict):
        require_ready()
        try:
            structure = structure_of(program)
        except ValueError as exc:   # the program's own shape is invalid
            raise HTTPException(status_code=422, detail=[{"condition_id": None, "message": str(exc)}])
        return context_from_env(load_environment(structure, offline=offline), offline)

    @app.get("/health")
    def health():
        return health_payload(offline=offline)

    @app.post("/warmup/retry")
    def warmup_retry():
        """Start loading again after a failed warm-up (network blip, bad cache)."""
        if not offline and WARM.snapshot()["state"] == "error":
            WARM.reset()
            WARM.start(_warm_literal)
        return WARM.snapshot()

    # ---- data resolution layer (docs/data-fallback-spec.md): feasibility chips, health page, prefetch, uploads
    @app.post("/feasibility")
    def feasibility_ep(program: dict = Body(embed=True), as_of: str = Body(embed=True),
                       user_id: int | None = Body(default=None), prompt_id: int | None = Body(default=None)):
        from engine.resolution.feasibility import check_program
        ctx = env_for(program)
        upload = {"user_id": user_id, "prompt_id": prompt_id} if user_id is not None and prompt_id is not None else None
        try:
            return {"feasibility": check_program(program, as_of, ctx, upload)}
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=[{"condition_id": None, "message": str(exc)}])

    @app.get("/data/health")
    def data_health_ep():
        from engine.resolution.ops import data_health
        return data_health([c.provenance for c in _CTX.values() if c.provenance])

    @app.post("/data/prefetch")
    def data_prefetch(force: bool = Body(default=False, embed=True)):
        import threading
        from engine.resolution.ops import run_prefetch
        threading.Thread(target=run_prefetch, kwargs={"force": force}, daemon=True).start()
        return {"started": True}

    @app.post("/data/upload")
    def data_upload(user_id: int = Body(embed=True), prompt_id: int = Body(embed=True),
                    name: str = Body(embed=True), text: str = Body(embed=True)):
        from engine.resolution.ops import save_upload
        try:
            path = save_upload(user_id, prompt_id, name, text)
        except Exception as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        return {"saved": path.name, "source": "user_upload", "quality": "ok"}

    # ---- "Refresh data": rebuild the weekly cache, swap it in, reload the engine's in-memory environment ----
    app.state.refresh_state = _refresh.RefreshState()

    def _literal_cache():
        if refresh_cache_dir is not None and refresh_weeks is not None:
            return Path(refresh_cache_dir), refresh_weeks
        from src.config import load_rule_spec
        spec = load_rule_spec("config/rules_literal.yaml")
        return Path(spec["data"]["cache_dir"]), spec["data"]["history_weeks"]

    def _reload_environment():
        from engine import env as _env
        with _env._GUARD:
            _env._CACHE.clear()
        _CTX.clear()
        if not offline:
            WARM.reset()
            WARM.start(_warm_literal)

    def _default_refresh(state):
        from src.config import load_rule_spec
        from src.data.adapter import build_adapter
        cache_dir, weeks = _literal_cache()
        adapter = build_adapter(load_rule_spec("config/rules_literal.yaml"))
        if _refresh.run_refresh(adapter, cache_dir, weeks, state):
            _reload_environment()

    @app.get("/data/refresh")
    def data_refresh_status():
        cache_dir, weeks = _literal_cache()
        return {**app.state.refresh_state.snapshot(), "last_refreshed": _refresh.last_refreshed(cache_dir, weeks)}

    @app.post("/data/refresh")
    def data_refresh_start():
        import threading
        state = app.state.refresh_state
        if not state.try_begin():
            return {**state.snapshot(), "started": False}

        def work():
            try:
                (refresh_runner or _default_refresh)(state)
            except Exception as exc:
                state.fail(f"{type(exc).__name__}: {exc}")

        threading.Thread(target=work, daemon=True).start()
        return {**state.snapshot(), "started": True}

    @app.get("/conditions/v5")
    def conditions_v5():
        return conditions_payload()

    # Full v5 result: every set's members, every action's output (the Interpret view's dry run).
    @app.post("/screen/v5")
    def screen_v5(program: dict = Body(embed=True), as_of: str = Body(embed=True), table: bool = Body(embed=True, default=False),
                  user_id: int | None = Body(default=None), prompt_id: int | None = Body(default=None)):
        ctx = with_upload(env_for(program), user_id, prompt_id)
        try:
            return run_program(program, as_of, ctx, full_table=table)
        except ProgramError as exc:
            raise _unprocessable(exc)

    # The shapes the app's persistence layer stores: candidates with membership, then selection outcomes.
    @app.post("/screen")
    def screen(program: dict = Body(embed=True), as_of: str = Body(embed=True),
               user_id: int | None = Body(default=None), prompt_id: int | None = Body(default=None)):
        ctx = with_upload(env_for(program), user_id, prompt_id)
        try:
            return screen_legacy(program, as_of, ctx)
        except ProgramError as exc:
            raise _unprocessable(exc)

    @app.post("/select")
    def select(program: dict = Body(embed=True), as_of: str = Body(embed=True),
               prompt_id: int | None = Body(default=None), run_kind: str = Body(default="dry_run"),
               user_id: int | None = Body(default=None)):
        ctx = with_upload(env_for(program), user_id, prompt_id)
        try:
            result = select_legacy(program, as_of, ctx)
        except ProgramError as exc:
            raise _unprocessable(exc)
        if run_kind != "dry_run" and prompt_id is not None and is_active(prompt_id):
            write_record(prompt_id, pd.Timestamp(as_of), result["entered"], program, structure_of(program),
                         scored=result["run_coverage"]["scored"])
        return result

    @app.post("/arms/register")
    def arms_register(prompt_id: int = Body(embed=True), program: dict = Body(embed=True)):
        try:
            structure = structure_of(program)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=[{"condition_id": None, "message": str(exc)}])
        register_arm(prompt_id, program, structure)
        return {"prompt_id": prompt_id, "status": "active"}

    @app.post("/arms/{prompt_id}/retire")
    def arms_retire(prompt_id: int):
        retire_arm(prompt_id)
        return {"prompt_id": prompt_id, "status": "retired"}

    @app.post("/validate")
    def validate(prompt_id: int = Body(embed=True), program: dict = Body(embed=True),
                 as_of: str = Body(embed=True), picks: list[dict] = Body(embed=True),
                 graded_weeks_so_far: int = Body(embed=True)):
        ctx = env_for(program)
        try:
            return validate_legacy(program, ctx, picks, as_of, graded_weeks_so_far)
        except (ValidationSpecError, ProgramError) as exc:
            raise HTTPException(status_code=422, detail=str(exc))

    @app.post("/quotes")
    def quotes(symbols: list[str] = Body(embed=True)):
        return fetch_quotes(symbols)

    @app.get("/series/{symbol}")
    def series(symbol: str, structure: str = "literal",
               vstop_length: int | None = None, vstop_mult: float | None = None,
               vstop_source: str | None = None, rsi_length: int | None = None):
        require_ready()
        env = load_environment(structure, offline=offline)
        vstop_params = {"length": vstop_length, "mult": vstop_mult, "source": vstop_source} if vstop_length is not None else None
        rsi_params = {"length": rsi_length} if rsi_length is not None else None
        return series_payload(symbol, env, vstop_params=vstop_params, rsi_params=rsi_params)

    # ---- P6 watchlist views: display-only metrics / fundamentals; nothing here feeds screening or grading ----
    def _symbols(raw: str) -> list[str]:
        out = list(dict.fromkeys(s.strip() for s in raw.split(",") if s.strip()))
        if not out or len(out) > 200:
            raise HTTPException(status_code=422, detail="symbols: 1-200 comma-separated tickers required")
        return out

    @app.get("/metrics")
    def metrics(symbols: str, tf: str = "1D"):
        if tf not in ("1D", "1W"):
            raise HTTPException(status_code=422, detail="tf must be 1D or 1W")
        return _metrics_service.compute_batch(_symbols(symbols), tf, history_fn or _metrics_service.default_history,
                                              today=pd.Timestamp.now().normalize())

    @app.get("/history/{symbol}")
    def history(symbol: str, weeks: int = 52):
        """Weekly closes for a benchmark/index chart (display only)."""
        df = (history_fn or _metrics_service.default_history)(symbol)
        if df is None or len(df) == 0:
            raise HTTPException(status_code=404, detail="no price history")
        d = df.dropna(subset=["close"]).copy()
        d["date"] = pd.to_datetime(d["date"])
        wk = d.groupby(d["date"].dt.to_period("W-FRI")).agg(date=("date", "last"), close=("close", "last")).tail(max(2, min(weeks, 520)))
        return {"symbol": symbol, "dates": [str(x.date()) for x in wk["date"]], "closes": [float(x) for x in wk["close"]]}

    @app.get("/fundamentals")
    def fundamentals(symbols: str):
        return (fundamentals_fn or _fundamentals.fetch_fundamentals)(_symbols(symbols))

    return app
