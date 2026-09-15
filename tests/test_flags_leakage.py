"""T-06: reuses tests/test_leakage.py's corruption/truncation probes against
build_flag_matrix — corrupting bars strictly after as_of must leave the
matrix unchanged (G3, and the same requirement replay makes of build_flag_matrix,
per §8.3)."""
from __future__ import annotations

import pandas as pd
import pytest

from src.flags.matrix import build_flag_matrix
from src.flags.registry import load_registry
from tests.offline import all_dates, env
from tests.test_leakage import _corrupt_after, _truncate_after

AS_OF_OFFSETS = [-3, -20]


def _comparable(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df
    cols = [c for c in df.columns if c not in ("recording_mode",)]
    return df[cols].sort_values("ticker").reset_index(drop=True)


@pytest.mark.parametrize("offset", AS_OF_OFFSETS)
def test_future_mutation_canary(offset):
    rule_spec, adapter, uni, panels, shares = env()
    as_of = all_dates(panels)[offset]
    registry = load_registry()

    base, _ = build_flag_matrix(as_of, rule_spec, registry, adapter, uni, panels, shares)
    mutated_panels = _corrupt_after(panels, as_of)
    mutated, _ = build_flag_matrix(as_of, rule_spec, registry, adapter, uni, mutated_panels, shares)

    pd.testing.assert_frame_equal(_comparable(base), _comparable(mutated), check_exact=False, rtol=1e-9)


@pytest.mark.parametrize("offset", AS_OF_OFFSETS)
def test_truncation_equivalence(offset):
    rule_spec, adapter, uni, panels, shares = env()
    as_of = all_dates(panels)[offset]
    registry = load_registry()

    full, _ = build_flag_matrix(as_of, rule_spec, registry, adapter, uni, panels, shares)
    trunc, _ = build_flag_matrix(as_of, rule_spec, registry, adapter, uni, _truncate_after(panels, as_of), shares)
    pd.testing.assert_frame_equal(_comparable(full), _comparable(trunc), check_exact=False, rtol=1e-9)
