"""Storage abstraction (plan §5.1). Business logic talks to `Store`; DATA_BACKEND=file|postgres picks the impl."""
from __future__ import annotations
import os
from .base import Store
from .file_store import FileStore


def get_store(backend: str | None = None) -> Store:
    backend = (backend or os.environ.get("DATA_BACKEND", "file")).lower()
    if backend == "file":
        return FileStore()
    if backend == "postgres":
        from .postgres_store import PostgresStore
        return PostgresStore()
    raise ValueError(f"unknown DATA_BACKEND {backend!r}")
