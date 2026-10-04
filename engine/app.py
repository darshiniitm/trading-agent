from __future__ import annotations

from fastapi import Body, FastAPI, HTTPException

from engine.conditions.catalog import catalog_payload
from engine.env import load_environment
from engine.health import health_payload
from engine.schemas import ScreenSpec
from engine.screen import ScreenSpecError, run_screen_spec
from engine.structures import structures_payload


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

    return app
