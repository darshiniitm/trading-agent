"""Write GOLDEN_VS_ACTUAL.md: for each prompt, the golden answer and what the code returned.
  python3 tests/golden/run_golden.py && cp tests/golden/results.json /tmp/pipeline.json
  python3 tests/golden/run_reference.py && python3 tests/golden/make_report.py /tmp/pipeline.json   (reference results = results.json)"""
import csv, json, sys
from pathlib import Path
H = Path(__file__).resolve().parent
prompts = json.loads((H / "prompts.json").read_text())
pipe = {r["id"]: r for r in json.loads(Path(sys.argv[1]).read_text())}
ref = {r["id"]: r for r in json.loads((H / "results.json").read_text())}

def golden(k):
    if k == "TC16": return [r["sector"] for r in csv.DictReader(open(H / "expected/TC16_sectors.csv")) if r["outperforming"] == "True"]
    if k == "TC20": return None
    return [r["ticker"] for r in csv.DictReader(open(H / f"expected/{k}.csv"))]

def fmt(l, n=40): return ", ".join(l[:n]) + (f" … (+{len(l) - n} more)" if len(l) > n else "")

out = ["# Prompt screener: 20 golden prompts, golden answer, result from code\n",
       "Screen date Fri 4 Sep 2026 (TC11: signal Fri 28 Aug). **Pipeline** = prompt text → compiler → engine. **Engine only** = hand-written correct program → engine.\n"]
for k in sorted(prompts):
    g, p, r = golden(k), pipe[k], ref[k]
    out.append(f"## {k}\n**Prompt:** {prompts[k]}\n")
    out.append(f"**Golden ({len(g)}):** {fmt(g)}\n" if g is not None else "**Golden:** 0 fully qualified (P/E and ROE have no data source); 51 technical-only partial matches\n")
    out.append(f"**Pipeline:** {p['status']}: {p['actual']} returned, {len(p['missing'])} missing, {len(p['extra'])} extra. {p.get('note', '')}  \n_Compiler read it as:_ {p.get('english', '')[:400]}\n")
    out.append(f"**Engine only:** {r['status']}: {r['actual']} returned, {len(r['missing'])} missing, {len(r['extra'])} extra. {r.get('note', '')}\n")
(H / "GOLDEN_VS_ACTUAL.md").write_text("\n".join(out))
print("pipeline", sum(v["status"] == "PASS" for v in pipe.values()), "/", len(pipe), "| engine only", sum(v["status"] == "PASS" for v in ref.values()), "/", len(ref))
