"""Guards against a hidden default sneaking into the evaluator (D6). Both tests below
are driven by engine.conditions.catalog.CATALOG itself, not by a hand-picked example,
so adding a new condition type to the catalog extends this coverage automatically:

1. Omitting any of a condition's required params must fail loudly (KeyError), never
   silently substitute a number.
2. Changing a required param to a different valid value must change the computed
   result -- otherwise the evaluator could be ignoring the param and using a fixed
   value that happens to look like it's "working".
"""
import pytest

from engine.conditions.catalog import CATALOG
from engine.conditions.evaluate import evaluate_ticker
from engine.schemas import Condition
from tests.offline import make_panel

# Distinct open/close and a rising volume series so every param under test (including
# vstop's `source` and traded_value_cr's `window`) is actually observable in the output.
#
# NOTE: brief specified a perfectly monotonic `[100 + i for i in range(40)]`. A perfectly
# monotonic series has zero down-bars, so compute_rsi (pre-existing, not modified by this
# task; see src/indicators/rsi.py) saturates at exactly 100.0 for EVERY period length --
# the "avg_loss == 0 -> 100 unconditionally" rule confirmed against TradingView 2026-09-29.
# That makes RSI(9) == RSI(14) == 100.0, so the length-sensitivity case of
# test_changing_a_required_param_changes_the_computed_value could never pass against the
# locked rsi.py. A small periodic pullback breaks the monotonicity (and the zero-loss
# degenerate case) without changing the series' overall rising shape, so every other
# sub-test (vstop length/mult/source, traded_value_cr window) still behaves as intended --
# confirmed numerically before making this change.
_closes = [100 + i for i in range(40)]
for _i in range(40):
    if _i % 6 == 0 and _i > 0:
        _closes[_i] = _closes[_i - 1] - 0.5
_PANEL = make_panel(_closes, opens=[c - 1 for c in _closes])
_PANEL = _PANEL.assign(volume=[1_000_000.0 + i * 50_000 for i in range(40)])


def _condition(key: str, params: dict) -> Condition:
    kind, name = key.split(":")
    op = CATALOG[key]["ops"][0]["op"]
    if op == "flip":
        return Condition(id="CX", role="event", kind=kind, name=name, params=params, op=op, dir="long")
    if name == "rsi":
        return Condition(id="CX", role="filter", kind=kind, name=name, params=params, op=op, value=[0, 100])
    if name == "traded_value_cr":
        return Condition(id="CX", role="filter", kind=kind, name=name, params=params, op=op, value=0)
    raise ValueError(f"no condition builder wired up for {key}")


@pytest.mark.parametrize("key", list(CATALOG.keys()))
def test_omitting_any_required_param_fails_loudly(key):
    entry = CATALOG[key]
    if not entry["required_params"]:
        pytest.skip(f"{key} has no required params to omit")

    full_params = {
        p["name"]: (p["values"][0] if p["type"] == "enum" else p["min"])
        for p in entry["required_params"]
    }
    for p in entry["required_params"]:
        incomplete = {k: v for k, v in full_params.items() if k != p["name"]}
        cond = _condition(key, incomplete)
        with pytest.raises(KeyError):
            evaluate_ticker(_PANEL, shares=1_000_000, conditions=[cond], as_of=_PANEL["date"].iloc[-1])


_BASELINE_PARAMS = {
    "indicator:vstop": {"length": 10, "mult": 2.0, "source": "close"},
    "indicator:rsi": {"length": 14},
    "field:traded_value_cr": {"window": "4W"},
}


@pytest.mark.parametrize("key, param_name, alt_value", [
    ("indicator:vstop", "length", 14),
    ("indicator:vstop", "mult", 3.0),
    ("indicator:vstop", "source", "open"),
    ("indicator:rsi", "length", 9),
    ("field:traded_value_cr", "window", "8W"),
])
def test_changing_a_required_param_changes_the_computed_value(key, param_name, alt_value):
    baseline_params = _BASELINE_PARAMS[key]
    alt_params = {**baseline_params, param_name: alt_value}
    as_of = _PANEL["date"].iloc[-1]

    r_baseline = evaluate_ticker(_PANEL, shares=1_000_000, conditions=[_condition(key, baseline_params)], as_of=as_of)
    r_alt = evaluate_ticker(_PANEL, shares=1_000_000, conditions=[_condition(key, alt_params)], as_of=as_of)

    read = (lambda r: r.values["CX"]["vstop_line"]) if key == "indicator:vstop" else (lambda r: r.values["CX"])
    assert read(r_baseline) != read(r_alt)
