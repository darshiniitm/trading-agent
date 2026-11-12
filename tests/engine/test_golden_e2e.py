"""End to end against the golden dataset (tests/golden): prompt -> program -> engine -> stocks, screen date 4 Sep 2026.

Two layers, both on the real frozen caches (skipped when the caches or compiled programs are not on this machine):
  reference programs  hand-written correct programs: the ENGINE alone must reproduce every golden answer;
  compiled programs   tests/golden/programs/TCxx.json, written by the frontend's scripts/golden-compile.ts from the prompt
                      text: the whole pipeline (compiler + engine) must reproduce every golden answer.
Regenerate the compiled programs after changing the compiler:
  cd frontend/apps/web && GOLDEN_DIR=<this repo>/tests/golden NO_MODEL=1 npx tsx scripts/golden-compile.ts
"""
import json
import sys
from pathlib import Path

import pytest

GOLDEN = Path(__file__).resolve().parents[1] / "golden"
sys.path.insert(0, str(GOLDEN))
ROOT = GOLDEN.parents[1]

needs_data = pytest.mark.skipif(not (ROOT / "data_cache_literal").exists() or not (GOLDEN / "golden.json").exists(),
                                reason="frozen golden caches are not on this machine")


@pytest.fixture(scope="module")
def rg():
    import run_golden
    return run_golden


@pytest.fixture(scope="module")
def ctx(rg):
    return rg.make_ctx()


@pytest.fixture(scope="module")
def golden():
    return json.loads((GOLDEN / "golden.json").read_text())


def _cases():
    return sorted(json.loads((GOLDEN / "golden.json").read_text())["cases"]) if (GOLDEN / "golden.json").exists() else []


@needs_data
@pytest.mark.parametrize("case", _cases())
def test_engine_reproduces_the_golden_answer_from_the_reference_program(case, rg, ctx, golden, tmp_path):
    from reference_programs import P
    if case not in P:
        pytest.skip("no reference program for this case")
    (tmp_path / f"{case}.json").write_text(json.dumps({"program": P[case], "english": "reference"}))
    rg.PROGRAMS_DIR = tmp_path
    row = rg.run_case(ctx, case, golden)
    assert row["status"] == "PASS", row


@needs_data
@pytest.mark.parametrize("case", _cases())
def test_whole_pipeline_reproduces_the_golden_answer_from_the_prompt(case, rg, ctx, golden):
    if not (GOLDEN / "programs" / f"{case}.json").exists():
        pytest.skip("compiled program not generated (run scripts/golden-compile.ts)")
    rg.PROGRAMS_DIR = GOLDEN / "programs"
    row = rg.run_case(ctx, case, golden)
    assert row["status"] == "PASS", row
