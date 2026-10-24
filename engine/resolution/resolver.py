"""DataResolver — the single entry point for raw inputs (spec §2, §3.1).

Each data type has an ordered provider chain. A provider failure (exception, timeout, empty result)
moves to the next provider and is recorded in `chain_trace`; it never raises to the engine.
"""
from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from dataclasses import replace
from datetime import date, datetime
from typing import Callable

from src import telemetry
from engine.resolution.config import load_config
from engine.resolution.types import (DataRequest, DataType, Provider, ProviderError, ProviderResult, Reason,
                                     ResolvedData, worst_quality)


class DataResolver:
    def __init__(self, config: dict | None = None, sleep: Callable[[float], None] = time.sleep,
                 gap_log: Callable[[dict], None] | None = None,
                 success_log: Callable[[str, str], None] | None = None):
        self.config = config or load_config()
        self._chains: dict[DataType, list[Provider]] = {}
        self._sleep = sleep
        self._gap_log = gap_log
        self._success_log = success_log
        self._pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="resolver")

    # ------------------------------------------------------------------ registration
    def register(self, data_type: DataType, chain: list[Provider]) -> None:
        self._chains[data_type] = list(chain)

    def chain(self, data_type: DataType) -> list[Provider]:
        return self._chains.get(data_type, [])

    # ------------------------------------------------------------------ resolution
    def resolve(self, request: DataRequest) -> ResolvedData:
        pcfg = self.config["providers"]
        trace: list[str] = []
        for i, prov in enumerate(self.chain(request.data_type)):
            res, err = self._call(prov, request, pcfg)
            if res is None:
                trace.append(f"{prov.name}:{err}")
                self._log_miss(request, prov, err)
                continue
            trace.append(f"{prov.name}:ok")
            self._ok(request, prov)
            primary = i == 0 or getattr(prov, "primary", False)
            quality = res.quality if primary else worst_quality(res.quality, "fallback")
            return ResolvedData(value=res.value, source=res.source or prov.name, as_of=res.as_of,
                                fetched_at=datetime.now(), quality=quality,
                                reason=res.reason.value if res.reason else None,
                                chain_trace=trace, meta=res.meta)
        return ResolvedData(value=None, source="none", as_of=None, fetched_at=datetime.now(), quality="missing",
                            reason=Reason.NO_DATA.value, chain_trace=trace)

    def resolve_panel(self, request: DataRequest) -> dict[str, ResolvedData]:
        """Per-symbol resolution for batch data (OHLCV): each symbol is served by the first provider that has it.
        Providers return value=dict[symbol, frame] and meta["per_symbol"][symbol] = {source, as_of, quality, reason, fields}."""
        pcfg = self.config["providers"]
        remaining, out, trace = list(request.symbols or []), {}, []
        for i, prov in enumerate(self.chain(request.data_type)):
            if not remaining:
                break
            res, err = self._call(prov, replace(request, symbols=remaining), pcfg)
            if res is None:
                trace.append(f"{prov.name}:{err}")
                self._log_miss(request, prov, err)
                continue
            trace.append(f"{prov.name}:ok")
            self._ok(request, prov)
            primary = i == 0 or getattr(prov, "primary", False)
            per = res.meta.get("per_symbol", {})
            for sym, frame in res.value.items():
                info = per.get(sym, {})
                q = info.get("quality") or res.quality
                reason = info.get("reason") or res.reason
                if not primary:
                    q = worst_quality(q, "fallback")
                out[sym] = ResolvedData(value=frame, source=info.get("source") or res.source or prov.name,
                                        as_of=info.get("as_of") or res.as_of, fetched_at=datetime.now(), quality=q,
                                        reason=getattr(reason, "value", reason), chain_trace=list(trace),
                                        meta={k: v for k, v in info.items() if k == "fields"})
            remaining = [x for x in remaining if x not in out]
        for sym in remaining:
            out[sym] = ResolvedData(value=None, source="none", as_of=None, fetched_at=datetime.now(), quality="missing",
                                    reason=Reason.NO_DATA.value, chain_trace=list(trace))
        return out

    def _call(self, prov: Provider, request: DataRequest, pcfg: dict) -> tuple[ProviderResult | None, str]:
        """One provider (with its retries) for one request. Observability: a `data.fetch` span per call and the
        data_fetch_* counters; a provider that simply has nothing ("unavailable") is routine and counts as skipped, not an error."""
        syms = list(request.symbols or [])
        with telemetry.tool_span("data.fetch", args={"source": prov.name, "data_type": request.data_type.value, "n_symbols": len(syms)}) as sp:
            res, err = self._call_impl(prov, request, pcfg)
            got = len(res.value) if res is not None and hasattr(res.value, "__len__") else (1 if res is not None else 0)
            sp.rows(len(syms), got)
            if res is None:
                routine = err.startswith("unavailable")
                sp.status("skipped" if routine else "error", err)
                if not routine:
                    telemetry.count_fetch(prov.name, syms, failed=True)
            else:
                telemetry.count_fetch(prov.name, syms, failed=False)
            return res, err

    def _call_impl(self, prov: Provider, request: DataRequest, pcfg: dict) -> tuple[ProviderResult | None, str]:
        attempts = 1 + int(pcfg.get("retries", 2))
        err = "error"
        for n in range(attempts):
            fut = telemetry.ctx_submit(self._pool, prov.fetch, request)   # carry the trace into the worker thread
            try:
                res = fut.result(timeout=pcfg.get("timeout_s", 15))
                if res is None or res.value is None or (hasattr(res.value, "__len__") and len(res.value) == 0):
                    return None, "empty"
                return res, "ok"
            except ProviderError as exc:
                return None, f"unavailable:{exc}"          # a definitive "I don't have it": no retry
            except FutureTimeout:
                fut.cancel()
                err = "timeout"
            except Exception as exc:                       # network / parse error: retry with backoff
                err = f"error:{type(exc).__name__}:{exc}"
            if n < attempts - 1:
                self._sleep(pcfg.get("backoff_s", 0.5) * (2 ** n))
        return None, err

    def _ok(self, request, prov) -> None:
        if self._success_log:
            self._success_log(prov.name, request.data_type.value)

    def _log_miss(self, request, prov, err: str) -> None:
        # a cold cache / absent snapshot is routine ("unavailable"); a real source returning nothing or failing is a gap
        if not err.startswith("unavailable") or getattr(prov, "log_miss", False):
            self._log(request, prov.name, err)

    def _log(self, request: DataRequest, provider: str, detail: str) -> None:
        if self._gap_log:
            self._gap_log({"data_type": request.data_type.value, "symbol": request.key if request.data_type != DataType.UNIVERSE else None,
                           "provider": provider, "reason": Reason.NO_DATA.value, "detail": detail})
