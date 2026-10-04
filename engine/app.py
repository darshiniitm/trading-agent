from __future__ import annotations

import pandas as pd
from fastapi import Body, FastAPI, HTTPException

from engine.arms import is_active, register_arm, retire_arm
from engine.conditions.catalog import catalog_payload
from engine.env import load_environment
from engine.forward_record import write_record
from engine.health import health_payload
from engine.quotes import fetch_quotes, series_payload
from engine.schemas import ScreenSpec
from engine.screen import ScreenSpecError, run_screen_spec
from engine.selection import select_candidates
from engine.structures import structures_payload
from engine.validation import ValidationSpecError, validate_arm


def create_app(offline: bool = False) -> FastAPI:
    app = FastAPI(title="prompt-screener-engine")

    @app.get("/health")
    def health():
        return health_payload(offline=offline)

    @app.get("/conditions")
    def conditions():
        return catalog_payload()

    @app.get("/structures")
    def structures():
        return structures_payload()

    @app.post("/screen")
    def screen(spec: ScreenSpec = Body(embed=True), as_of: str = Body(embed=True)):
        env = load_environment(spec.structure, offline=offline)
        try:
            return run_screen_spec(spec, as_of, env)
        except ScreenSpecError as exc:
            raise HTTPException(status_code=422, detail=[
                {"condition_id": e.condition_id, "message": e.message} for e in exc.errors
            ])

    @app.post("/select")
    def select(spec: ScreenSpec = Body(embed=True), as_of: str = Body(embed=True),
               prompt_id: int | None = Body(default=None), run_kind: str = Body(default="dry_run")):
        env = load_environment(spec.structure, offline=offline)
        try:
            screen_result = run_screen_spec(spec, as_of, env)
        except ScreenSpecError as exc:
            raise HTTPException(status_code=422, detail=[
                {"condition_id": e.condition_id, "message": e.message} for e in exc.errors
            ])
        result = select_candidates(spec, as_of, env, screen_result)
        if run_kind != "dry_run" and prompt_id is not None and is_active(prompt_id):
            write_record(prompt_id, pd.Timestamp(as_of), result["entered"], spec)
        return result

    @app.post("/arms/register")
    def arms_register(prompt_id: int = Body(embed=True), spec: ScreenSpec = Body(embed=True)):
        register_arm(prompt_id, spec)
        return {"prompt_id": prompt_id, "status": "active"}

    @app.post("/arms/{prompt_id}/retire")
    def arms_retire(prompt_id: int):
        retire_arm(prompt_id)
        return {"prompt_id": prompt_id, "status": "retired"}

    @app.post("/validate")
    def validate(prompt_id: int = Body(embed=True), spec: ScreenSpec = Body(embed=True),
                  as_of: str = Body(embed=True), picks: list[dict] = Body(embed=True),
                  graded_weeks_so_far: int = Body(embed=True)):
        env = load_environment(spec.structure, offline=offline)
        vstop_cond = next((c for c in spec.conditions if spec.stop and c.id == spec.stop.from_), None)
        vstop_params = vstop_cond.params if vstop_cond else None
        try:
            return validate_arm(prompt_id, env, picks, as_of, graded_weeks_so_far,
                                 vstop_params=vstop_params)
        except ValidationSpecError as exc:
            raise HTTPException(status_code=422, detail=str(exc))

    @app.post("/quotes")
    def quotes(symbols: list[str] = Body(embed=True)):
        return fetch_quotes(symbols)

    @app.get("/series/{symbol}")
    def series(symbol: str, structure: str = "literal"):
        env = load_environment(structure, offline=offline)
        return series_payload(symbol, env)

    return app
