from engine.quotes import fetch_quotes


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


def test_series_endpoint(client, literal_env):
    ticker = next(iter(literal_env.panels))
    resp = client.get(f"/series/{ticker}", params={"structure": "literal"})
    assert resp.status_code == 200
    body = resp.json()
    assert "bars" in body and len(body["bars"]) > 0
