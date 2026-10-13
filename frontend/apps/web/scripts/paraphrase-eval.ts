// Compiler robustness: each golden prompt reworded the way real traders type it must compile to the SAME conditions
// as the original. Rules only by default; MODEL=1 also lets the local model (Ollama) read what the rules could not.
//   npx tsx scripts/paraphrase-eval.ts            rules only
//   MODEL=1 npx tsx scripts/paraphrase-eval.ts    rules + Reader + per-line fallback + critic
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { interpret } from "../src/server/compiler/v5/interpret";
import { compileProgram } from "../src/server/compiler/v5/compileProgram";
import { ollamaFor } from "../src/server/compiler/callModel";
import { makeModelReader } from "../src/server/compiler/v5/modelRead";
import { canonicalTrader } from "../tests/v5/helpers/canonTrader";

const fx = (n: string) => JSON.parse(readFileSync(path.join(process.cwd(), "tests/v5/fixtures", n), "utf8"));
const base: Record<string, string> = fx("golden-trader-prompts.json");
const paras: Record<string, string[]> = fx((process.env.SET === "heldout" ? "golden-trader-heldout.json" : process.env.SET === "fresh" ? "golden-trader-fresh.json" : process.env.SET === "blind" ? "golden-trader-blind.json" : "golden-trader-paraphrases.json"));
const useModel = process.env.MODEL === "1";
const modelName = process.env.MODEL_NAME ?? "mistral:latest";
const reader = makeModelReader(ollamaFor(modelName));
const only = process.argv.slice(2);

const norm = (l: string[]) => [...l].sort();
async function main() {
  const rows: any[] = [];
  for (const id of Object.keys(paras).sort()) {
    if (only.length && !only.includes(id)) continue;
    const want = norm(canonicalTrader((await compileProgram(base[id])).program));
    for (const [k, text] of paras[id].entries()) {
      try {
        const r = await interpret(text, useModel ? { modelRead: reader } : {});
        const got = norm(canonicalTrader(r.program));
        const same = JSON.stringify(got) === JSON.stringify(want);
        rows.push({ id, k, pass: same, modelCalls: r.draft.modelCalls, missing: want.filter((x) => !got.includes(x)), extra: got.filter((x) => !want.includes(x)), issues: r.issues.map((i) => i.note), text });
      } catch (e) { rows.push({ id, k, pass: false, error: (e as Error).message, text }); }
      process.stdout.write(rows.at(-1).pass ? "." : "x");
    }
  }
  console.log("");
  writeFileSync(path.join(process.cwd(), `results/paraphrase-${process.env.SET ?? "tuned"}-${useModel ? "model-" + modelName.replace(/[^a-z0-9]/gi, "_") : "rules"}.json`), JSON.stringify(rows, null, 1));
  const pass = rows.filter((r) => r.pass).length;
  console.log(`${useModel ? "rules + " + modelName : "rules only"}: ${pass}/${rows.length} paraphrases compile to the original's conditions`);
  for (const r of rows.filter((x) => !x.pass)) console.log(`\n${r.id}#${r.k}  ${r.text.slice(0, 110)}\n  missing: ${JSON.stringify(r.missing ?? r.error)}\n  extra:   ${JSON.stringify(r.extra ?? [])}`);
}
main();
