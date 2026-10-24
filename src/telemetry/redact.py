"""Redaction for everything that leaves the process (spans, logs, Postgres rows).

Mirrors web/src/server/telemetry/redact.ts; both are tested against observability/redaction-fixtures.json.
User ids are HMAC-hashed, never stored raw.
"""
from __future__ import annotations

import hashlib
import hmac
import re

MAX_FIELD_CHARS = 16 * 1024
# `token(?!s)`: a token COUNT (input_tokens, tokens) is telemetry, a `token` is a credential.
_SECRET_KEY = re.compile(r"(authorization|api[-_]?key|password|passwd|secret|cookie|token(?!s))", re.I)
_PATTERNS = [
    (re.compile(r"(postgres(?:ql)?://[^:\s/@]+:)[^@\s]+(@)", re.I), r"\1[redacted]\2"),
    (re.compile(r"(Bearer\s+)[^\s\"',;]+", re.I), r"\1[redacted]"),
    (re.compile(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"), "[redacted]"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{8,}"), "[redacted]"),
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "[redacted-email]"),
]


def redact_string(s: str) -> str:
    for pat, repl in _PATTERNS:
        s = pat.sub(repl, s)
    return s


def redact_value(v, _seen: set | None = None):
    if isinstance(v, str):
        return redact_string(v)
    if v is None or not isinstance(v, (dict, list, tuple)):
        return v
    seen = _seen if _seen is not None else set()
    if id(v) in seen:
        return "[circular]"
    seen.add(id(v))
    if isinstance(v, dict):
        return {k: "[redacted]" if _SECRET_KEY.search(str(k)) else redact_value(val, seen) for k, val in v.items()}
    return [redact_value(x, seen) for x in v]


def hash_user(user_id, salt: str) -> str:
    return hmac.new(salt.encode(), str(user_id).encode(), hashlib.sha256).hexdigest()[:16]


def truncate(s: str, max_chars: int = MAX_FIELD_CHARS) -> tuple[str, bool]:
    return (s[:max_chars], True) if len(s) > max_chars else (s, False)
