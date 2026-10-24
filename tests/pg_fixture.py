"""Embedded throwaway Postgres (pgserver) for hermetic DB tests — never touches Supabase."""
from __future__ import annotations
import tempfile
import pgserver


def temp_pg():
    d = tempfile.mkdtemp(prefix="pgtest_")
    srv = pgserver.get_server(d, cleanup_mode="stop")
    return srv, srv.get_uri()
