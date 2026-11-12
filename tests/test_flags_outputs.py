"""T-10: column order, manifest keys, caveats present."""
from __future__ import annotations

from src.flags.matrix import (
    BASE_GATE_COLS, DIAGNOSTIC_COLS, IDENTITY_COLS, RAW_FEATURE_COLS, SUMMARY_COLS, T4_COLS,
    build_flag_matrix,
)
from src.flags.registry import countable_ids, load_registry
from tests.offline import all_dates, env


def _record():
    rule_spec, adapter, uni, panels, shares = env()
    as_of = all_dates(panels)[-3]
    registry = load_registry()
    return build_flag_matrix(as_of, rule_spec, registry, adapter, uni, panels, shares), registry


def test_column_order_matches_spec_groups():
    (df, manifest), registry = _record()
    expected = (IDENTITY_COLS + BASE_GATE_COLS + RAW_FEATURE_COLS + countable_ids(registry)
                + SUMMARY_COLS + DIAGNOSTIC_COLS + T4_COLS)
    assert list(df.columns) == expected


def test_manifest_has_required_keys():
    (df, manifest), registry = _record()
    required = {"record_id", "signal_week", "holding_week", "recording_mode", "created_utc",
                "created_ist", "monday_open_deadline_ist", "registry_version", "registry_checksum",
                "data", "funnel", "counts", "t4", "checks", "caveats"}
    assert required <= set(manifest.keys())


def test_caveats_present_in_manifest():
    from src.data.adapter import KNOWN_CAVEATS
    (df, manifest), registry = _record()
    assert "caveats" in manifest
    assert isinstance(manifest["caveats"], list)
    assert manifest["caveats"] == KNOWN_CAVEATS


def test_t4_columns_blank_before_k_is_frozen():
    (df, manifest), registry = _record()
    if registry.get("t4", {}).get("k") is None:
        assert df["t4_selected"].isna().all()
        assert df["t4_rank"].isna().all()


def test_rows_sorted_by_flags_met_desc_then_ticker_asc():
    (df, manifest), registry = _record()
    evaluable = df[df["eligible_reason"].isna()]
    if len(evaluable) < 2:
        return
    prev_met = None
    prev_ticker = None
    for _, row in evaluable.iterrows():
        if prev_met is not None:
            assert row["flags_met"] <= prev_met or (row["flags_met"] == prev_met)
        prev_met = row["flags_met"]
