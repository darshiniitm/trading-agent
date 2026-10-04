from __future__ import annotations

CATALOG: dict[str, dict] = {
    "field:mcap_cr": {
        "kind": "field", "name": "mcap_cr",
        "required_params": [],
        "ops": [{"op": "between", "requires_value": True, "value_shape": "[min, max]"}],
    },
    "field:traded_value_cr": {
        "kind": "field", "name": "traded_value_cr",
        "required_params": [
            {"name": "window", "type": "week_window_str", "min": "1W", "max": "52W"},
        ],
        "ops": [{"op": ">=", "requires_value": True, "value_shape": "number"}],
    },
    "indicator:vstop": {
        "kind": "indicator", "name": "vstop",
        "required_params": [
            {"name": "length", "type": "int", "min": 2, "max": 100},
            {"name": "mult", "type": "float", "min": 0.1, "max": 10.0},
            {"name": "source", "type": "enum", "values": ["open", "high", "low", "close"]},
        ],
        "ops": [{"op": "flip", "requires_value": False, "value_shape": "dir: long"}],
    },
    "indicator:rsi": {
        "kind": "indicator", "name": "rsi",
        "required_params": [
            {"name": "length", "type": "int", "min": 2, "max": 100},
        ],
        "ops": [{"op": "between", "requires_value": True, "value_shape": "[lo, hi] within [0, 100]"}],
    },
}


def catalog_payload() -> list[dict]:
    return list(CATALOG.values())
