"""Run the hand-written reference programs through the engine: does the ENGINE reproduce each golden list?
  python3 tests/golden/run_reference.py [TC01 ...]"""
import json, sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1])); sys.path.insert(0, str(HERE))
import run_golden as rg
from reference_programs import P
out = HERE / "reference_out"; out.mkdir(exist_ok=True)
ids = sys.argv[1:] or sorted(P)
for k in ids:
    (out / f"{k}.json").write_text(json.dumps({"program": P[k], "english": "reference"}))
rg.main(ids, out)
