from __future__ import annotations

from fastapi import FastAPI

from engine.health import health_payload


def create_app() -> FastAPI:
    app = FastAPI(title="prompt-screener-engine")

    @app.get("/health")
    def health():
        return health_payload()

    return app
