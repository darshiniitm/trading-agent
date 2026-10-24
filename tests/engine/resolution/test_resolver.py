from __future__ import annotations

from datetime import date

from engine.resolution.resolver import DataResolver
from engine.resolution.types import DataRequest, DataType, ProviderError, ProviderResult, Reason

REQ = DataRequest(DataType.UNIVERSE, date(2026, 10, 5), key="NIFTY 100")


class Fake:
    data_type = DataType.UNIVERSE

    def __init__(self, name, result=None, exc=None, primary=False, delay=0.0):
        self.name, self._r, self._e, self.primary, self._d, self.calls = name, result, exc, primary, delay, 0

    def fetch(self, request):
        import time
        self.calls += 1
        if self._d: time.sleep(self._d)
        if self._e: raise self._e
        return self._r


def res(cfg_over=None, *chain):
    cfg = {"providers": {"timeout_s": 0.2, "retries": 2, "backoff_s": 0.0}}
    r = DataResolver(config=cfg, sleep=lambda s: None)
    r.register(DataType.UNIVERSE, list(chain))
    return r


def ok(v=("A",)): return ProviderResult(list(v), date(2026, 10, 1))


def test_first_provider_wins_and_is_ok():
    a, b = Fake("a", ok()), Fake("b", ok())
    out = res(None, a, b).resolve(REQ)
    assert out.quality == "ok" and out.source == "a" and b.calls == 0 and out.chain_trace == ["a:ok"]


def test_lower_priority_success_is_fallback():
    out = res(None, Fake("a", exc=RuntimeError("boom")), Fake("b", ok())).resolve(REQ)
    assert out.quality == "fallback" and out.source == "b"
    assert out.chain_trace[0].startswith("a:error") and out.chain_trace[1] == "b:ok"


def test_primary_flag_keeps_ok_on_later_tier():
    out = res(None, Fake("a", exc=ProviderError("none")), Fake("snap", ok(), primary=True)).resolve(REQ)
    assert out.quality == "ok"


def test_provider_declared_quality_is_preserved_and_worst_wins():
    stale = ProviderResult(["A"], date(2026, 1, 1), quality="stale", reason=Reason.STALE_DATA)
    out = res(None, Fake("a", stale)).resolve(REQ)
    assert out.quality == "stale" and out.reason == "stale_data"
    approx = ProviderResult(["A"], date(2026, 10, 5), quality="approx", reason=Reason.APPROX_INPUT)
    out = res(None, Fake("a", exc=ProviderError("x")), Fake("b", approx)).resolve(REQ)
    assert out.quality == "approx"


def test_timeout_retries_then_moves_on():
    slow = Fake("slow", ok(), delay=0.5)
    out = res(None, slow, Fake("b", ok())).resolve(REQ)
    assert slow.calls == 3 and out.source == "b" and "slow:timeout" in out.chain_trace


def test_definitive_unavailable_is_not_retried():
    a = Fake("a", exc=ProviderError("no snapshot"))
    res(None, a, Fake("b", ok())).resolve(REQ)
    assert a.calls == 1


def test_empty_result_moves_on_and_all_fail_is_missing_never_raises():
    out = res(None, Fake("a", ProviderResult([], date(2026, 10, 1))), Fake("b", exc=ValueError("x"))).resolve(REQ)
    assert out.quality == "missing" and out.reason == "no_data" and out.value is None


def test_gap_log_records_each_failure():
    rows = []
    r = DataResolver(config={"providers": {"timeout_s": 0.2, "retries": 0, "backoff_s": 0}}, sleep=lambda s: None, gap_log=rows.append)
    r.register(DataType.UNIVERSE, [Fake("a", exc=ValueError("x")), Fake("b", ok())])
    r.resolve(REQ)
    assert [x["provider"] for x in rows] == ["a"]
