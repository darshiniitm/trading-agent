from engine.quotes import fetch_quotes, series_payload


class _FakeFastInfo(dict):
    pass


class _FakeTicker:
    def __init__(self, symbol):
        self.symbol = symbol
        if symbol == "BAD.NS":
            raise RuntimeError("no such ticker")
        self.fast_info = _FakeFastInfo(last_price=123.45)


def test_fetch_quotes_returns_price_per_symbol():
    result = fetch_quotes(["AAA.NS"], yf_ticker_factory=_FakeTicker)
    assert result["AAA.NS"]["price"] == 123.45
    assert result["AAA.NS"]["source"] == "yahoo"


def test_fetch_quotes_isolates_a_failing_symbol():
    result = fetch_quotes(["AAA.NS", "BAD.NS"], yf_ticker_factory=_FakeTicker)
    assert result["AAA.NS"]["price"] == 123.45
    assert "error" in result["BAD.NS"]


def test_series_endpoint_without_params(client, literal_env):
    """GET /series/{symbol} without indicator params returns plain OHLCV bars."""
    ticker = next(iter(literal_env.panels))
    resp = client.get(f"/series/{ticker}", params={"structure": "literal"})
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
    # Verify no indicator columns
    assert "vstop_line" not in bar
    assert "rsi" not in bar


def test_series_endpoint_with_vstop(client, literal_env):
    """GET /series/{symbol} with vstop params returns OHLCV + vstop indicator values."""
    ticker = next(iter(literal_env.panels))
    resp = client.get(
        f"/series/{ticker}",
        params={
            "structure": "literal",
            "vstop_length": 10,
            "vstop_mult": 2.0,
            "vstop_source": "close"
        }
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "bars" in body and len(body["bars"]) > 0
    # Verify base columns exist
    assert "date" in body["bars"][0]
    assert "close" in body["bars"][0]
    # Verify vstop indicator keys exist on all bars
    assert all("vstop_line" in bar for bar in body["bars"])
    assert all("uptrend" in bar for bar in body["bars"])
    # Verify at least one bar past warmup (index 15+) has non-None vstop_line value
    assert any(bar["vstop_line"] is not None for bar in body["bars"][15:])


def test_series_endpoint_with_rsi(client, literal_env):
    """GET /series/{symbol} with rsi params returns OHLCV + rsi indicator values."""
    ticker = next(iter(literal_env.panels))
    resp = client.get(
        f"/series/{ticker}",
        params={
            "structure": "literal",
            "rsi_length": 14
        }
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "bars" in body and len(body["bars"]) > 0
    # Verify base columns exist
    assert "date" in body["bars"][0]
    assert "close" in body["bars"][0]
    # Verify rsi indicator key exists on all bars
    assert all("rsi" in bar for bar in body["bars"])
    # Verify at least one bar past warmup (index 15+) has non-None rsi value
    assert any(bar["rsi"] is not None for bar in body["bars"][15:])


def test_series_payload_without_params(literal_env):
    """series_payload without params returns plain OHLCV bars."""
    ticker = next(iter(literal_env.panels))
    result = series_payload(ticker, literal_env)
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
    assert "vstop_line" not in bar
    assert "rsi" not in bar


def test_series_payload_with_vstop(literal_env):
    """series_payload with vstop params returns indicator values per bar."""
    ticker = next(iter(literal_env.panels))
    vstop_params = {"length": 10, "mult": 2.0, "source": "close"}
    result = series_payload(ticker, literal_env, vstop_params=vstop_params)
    assert "bars" in result
    assert len(result["bars"]) > 0
    # Verify indicator columns exist on all bars
    assert all("vstop_line" in bar for bar in result["bars"])
    assert all("uptrend" in bar for bar in result["bars"])
    # Verify at least one bar past warmup has non-None vstop_line value
    assert any(bar["vstop_line"] is not None for bar in result["bars"][15:])


def test_series_payload_with_rsi(literal_env):
    """series_payload with rsi params returns RSI values per bar."""
    ticker = next(iter(literal_env.panels))
    rsi_params = {"length": 14}
    result = series_payload(ticker, literal_env, rsi_params=rsi_params)
    assert "bars" in result
    assert len(result["bars"]) > 0
    # Verify indicator column exists on all bars
    assert all("rsi" in bar for bar in result["bars"])
    # Verify at least one bar past warmup has non-None rsi value
    assert any(bar["rsi"] is not None for bar in result["bars"][15:])
