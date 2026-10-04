from __future__ import annotations

from fastapi import FastAPI

from engine.conditions.catalog import catalog_payload
from engine.health import health_payload


def create_app() -> FastAPI:
    app = FastAPI(title="prompt-screener-engine")

    @app.get("/health")
    def health():
        return health_payload()

    @app.get("/conditions")
    def conditions():
        return catalog_payload()

    return app
