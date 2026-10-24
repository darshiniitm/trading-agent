"""Crash-safe cache files.

A cache file is written to a temp name in the same directory and moved into place with os.replace(), which is atomic on
POSIX: a concurrent reader sees the old file or the new one, never a half-written one (the "Page was smaller than
expected" read failure). A file that cannot be read anyway (a crash from before this existed, a full disk) is moved
aside as <name>.corrupt-<ts> and treated as a cache miss, so the caller refetches instead of failing the request.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pandas as pd


def _tmp(path: Path) -> Path:
    return path.with_name(f"{path.name}.tmp.{os.getpid()}.{time.time_ns()}")


def atomic_write_text(path: Path, text: str) -> None:
    path = Path(path)
    tmp = _tmp(path)
    try:
        tmp.write_text(text)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def atomic_write_json(path: Path, obj) -> None:
    atomic_write_text(path, json.dumps(obj))


def atomic_write_parquet(df: pd.DataFrame, path: Path) -> None:
    path = Path(path)
    tmp = _tmp(path)
    try:
        df.to_parquet(tmp, index=False)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def atomic_write_csv(df: pd.DataFrame, path: Path) -> None:
    path = Path(path)
    tmp = _tmp(path)
    try:
        df.to_csv(tmp, index=False)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def quarantine(path: Path) -> Path | None:
    """Move an unreadable cache file aside (kept for inspection). Returns the new path, or None if it was already gone."""
    path = Path(path)
    dest = path.with_name(f"{path.name}.corrupt-{int(time.time())}")
    try:
        os.replace(path, dest)
        return dest
    except FileNotFoundError:
        return None


def read_parquet_or_none(path: Path) -> pd.DataFrame | None:
    """The parquet at `path`, or None if it is missing or unreadable (an unreadable one is quarantined)."""
    path = Path(path)
    try:
        return pd.read_parquet(path)
    except FileNotFoundError:
        return None
    except Exception:   # OSError / pyarrow.ArrowInvalid / ArrowIOError: truncated or corrupt
        quarantine(path)
        return None


def read_json_or_none(path: Path):
    path = Path(path)
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return None
    except ValueError:
        quarantine(path)
        return None
