from engine.quotes import fetch_quotes, series_payload
from engine.schemas import Condition, ScreenSpec, Stop


class _FakeFastInfo(dict):
    pass


class _FakeTicker:
    def __init__(self, symbol):
        self.symbol = symbol
        if symbol == "BAD.NS":
            raise RuntimeError("no such ticker")
        self.fast_info = _FakeFastInfo(last_price=123.45)


def _literal_spec():
    """Minimal spec with vstop and rsi indicators."""
    return ScreenSpec(
        spec_version=4, structure="literal", timeframe="1W", selection_point=None,
        conditions=[
            Condition(id="C1", role="filter", kind="field", name="mcap_cr", op="between", value=[10000, 50000]),
            Condition(id="C3", role="event", kind="indicator", name="vstop",
                      params={"length": 10, "mult": 2.0, "source": "close"}, op="flip", dir="long"),
            Condition(id="C4", role="filter", kind="indicator", name="rsi",
                      params={"length": 14}, op="between", value=[50, 65]),
        ],
        stop=Stop(**{"from": "C3"}), risk_cap_pct=None, near_miss=None,
    )


def test_fetch_quotes_returns_price_per_symbol():
    result = fetch_quotes(["AAA.NS"], yf_ticker_factory=_FakeTicker)
    assert result["AAA.NS"]["price"] == 123.45
    assert result["AAA.NS"]["source"] == "yahoo"


def test_fetch_quotes_isolates_a_failing_symbol():
    result = fetch_quotes(["AAA.NS", "BAD.NS"], yf_ticker_factory=_FakeTicker)
    assert result["AAA.NS"]["price"] == 123.45
    assert "error" in result["BAD.NS"]


def test_series_endpoint_without_spec(client, literal_env):
    """POST /series/{symbol} without spec returns plain OHLCV bars."""
    ticker = next(iter(literal_env.panels))
    resp = client.post(f"/series/{ticker}", params={"structure": "literal"})
    assert resp.status_code == 200
    body = resp.json()
    assert "bars" in body and len(body["bars"]) > 0
    # Verify it contains only base OHLCV columns
    bar = body["bars"][0]
    assert "date" in bar
    assert "open" in bar
    assert "high" in bar
    assert "low" in bar
    assert "close" in bar
    assert "volume" in bar


def test_series_endpoint_with_spec(client, literal_env):
    """POST /series/{symbol} with spec returns OHLCV + indicator values per bar."""
    ticker = next(iter(literal_env.panels))
    spec = _literal_spec()
    resp = client.post(
        f"/series/{ticker}",
        params={"structure": "literal"},
        json={"spec": spec.model_dump(by_alias=True)}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "bars" in body and len(body["bars"]) > 0
    bar = body["bars"][0]
    # Verify base columns exist
    assert "date" in bar
    assert "close" in bar
    # Verify indicator values are present for both conditions
    assert "C3_vstop_line" in bar
    assert "C3_uptrend" in bar
    assert "C4_rsi" in bar


def test_series_payload_without_spec(literal_env):
    """series_payload with spec=None returns plain OHLCV bars."""
    ticker = next(iter(literal_env.panels))
    result = series_payload(ticker, literal_env, spec=None)
    assert "bars" in result
    assert len(result["bars"]) > 0
    bar = result["bars"][0]
    assert "date" in bar
    assert "open" in bar
    assert "high" in bar
    assert "low" in bar
    assert "close" in bar
    assert "volume" in bar
    # Verify no indicator columns
    assert not any(k.startswith("C") and "_" in k for k in bar.keys())


def test_series_payload_with_spec(literal_env):
    """series_payload with spec returns indicator values per bar."""
    ticker = next(iter(literal_env.panels))
    spec = _literal_spec()
    result = series_payload(ticker, literal_env, spec)
    assert "bars" in result
    assert len(result["bars"]) > 0
    bar = result["bars"][0]
    # Verify indicator columns exist
    assert "C3_vstop_line" in bar
    assert "C3_uptrend" in bar
    assert "C4_rsi" in bar
