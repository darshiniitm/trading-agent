from __future__ import annotations

from datetime import datetime, timezone

from engine.env import Environment


def _prev_close(info) -> float | None:
    # Optional: a missing/zero previous close just means the day change is unknown, never a failed quote.
    try:
        raw = info["previous_close"] if isinstance(info, dict) else info.previous_close
        value = float(raw)
        return value if value > 0 else None
    except Exception:
        return None


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
            entry = {"price": float(price), "source": "yahoo", "source_ts": now}
            prev = _prev_close(info)
            if prev is not None:
                entry["prev_close"] = prev
            out[symbol] = entry
        except Exception as exc:
            out[symbol] = {"error": str(exc)}
    return out


def series_payload(symbol: str, env: Environment, vstop_params=None, rsi_params=None) -> dict:
    import pandas as pd

    panel = env.panels.get(symbol)
    if panel is None or panel.empty:
        return {"symbol": symbol, "bars": []}

    # Start with base OHLCV columns
    bars_df = panel[["date", "open", "high", "low", "close", "volume"]].copy()
    bars_df["date"] = bars_df["date"].astype(str)

    # Compute and attach indicator values if params are provided
    if vstop_params is not None:
        from src.indicators.vstop_tv import compute_vstop_tv as compute_vstop

        vstop_result = compute_vstop(
            panel,
            length=vstop_params.get("length", 10),
            mult=vstop_params.get("mult", 2.0),
            source=vstop_params.get("source", "close")
        )
        # Attach vstop_line and uptrend with fixed keys (no condition id needed)
        bars_df["vstop_line"] = vstop_result["vstop_line"]
        bars_df["uptrend"] = vstop_result["uptrend"]

    if rsi_params is not None:
        from src.indicators.rsi import compute_rsi

        rsi_values = compute_rsi(panel["close"], period=rsi_params.get("length", 14))
        # Attach RSI values with fixed key
        bars_df["rsi"] = rsi_values

    # Convert to dict records and handle NaN/None serialization
    records = bars_df.to_dict("records")
    for record in records:
        for key, value in record.items():
            # Convert NaN to None for JSON serialization
            if pd.isna(value):
                record[key] = None

    return {"symbol": symbol, "bars": records}
