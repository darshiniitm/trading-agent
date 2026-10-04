from __future__ import annotations

from datetime import datetime, timezone

from engine.env import Environment


def fetch_quotes(symbols: list[str], yf_ticker_factory=None) -> dict[str, dict]:
    if yf_ticker_factory is None:
        import yfinance as yf
        yf_ticker_factory = yf.Ticker

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    out: dict[str, dict] = {}
    for symbol in symbols:
        try:
            info = yf_ticker_factory(symbol).fast_info
            price = info["last_price"] if isinstance(info, dict) else info.last_price
            out[symbol] = {"price": float(price), "source": "yahoo", "source_ts": now}
        except Exception as exc:
            out[symbol] = {"error": str(exc)}
    return out


def series_payload(symbol: str, env: Environment) -> dict:
    panel = env.panels.get(symbol)
    if panel is None or panel.empty:
        return {"symbol": symbol, "bars": []}
    bars = panel[["date", "open", "high", "low", "close", "volume"]].copy()
    bars["date"] = bars["date"].astype(str)
    return {"symbol": symbol, "bars": bars.to_dict("records")}
