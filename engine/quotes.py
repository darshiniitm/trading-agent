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


def series_payload(symbol: str, env: Environment, spec=None) -> dict:
    import pandas as pd

    panel = env.panels.get(symbol)
    if panel is None or panel.empty:
        return {"symbol": symbol, "bars": []}

    # Start with base OHLCV columns
    bars_df = panel[["date", "open", "high", "low", "close", "volume"]].copy()
    bars_df["date"] = bars_df["date"].astype(str)

    # If a spec is provided, compute and attach indicator values
    if spec is not None:
        from src.indicators.vstop import compute_vstop
        from src.indicators.rsi import compute_rsi

        for cond in spec.conditions:
            if cond.kind != "indicator":
                continue

            if cond.name == "vstop":
                # Compute vstop for this symbol's panel
                params = cond.params
                vstop_result = compute_vstop(
                    panel,
                    length=params.get("length", 10),
                    mult=params.get("mult", 2.0),
                    source=params.get("source", "close")
                )
                # Attach vstop_line and uptrend with condition id as key
                bars_df[f"{cond.id}_vstop_line"] = vstop_result["vstop_line"]
                bars_df[f"{cond.id}_uptrend"] = vstop_result["uptrend"]

            elif cond.name == "rsi":
                # Compute RSI for this symbol's close
                params = cond.params
                rsi_values = compute_rsi(panel["close"], period=params.get("length", 14))
                # Attach RSI values with condition id as key
                bars_df[f"{cond.id}_rsi"] = rsi_values

    # Convert to dict records and handle NaN/None serialization
    records = bars_df.to_dict("records")
    for record in records:
        for key, value in record.items():
            # Convert NaN to None for JSON serialization
            if pd.isna(value):
                record[key] = None

    return {"symbol": symbol, "bars": records}
