// Plan §6 "Model fallback" / §8 decision 5: run the golden + paraphrase set with the condition
// recognisers DISABLED, so every condition line goes through the model fallback, against each
// candidate local model, and record the pass rate.
//   npx tsx scripts/eval-compiler-model.ts mistral:latest gemma4:latest
// Pass-rate threshold (yours to set): EVAL_THRESHOLD=0.9 -> exit 1 if a model is below it.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compileProgram } from "../src/server/compiler/v5/compileProgram";
import { makeClauseFallback } from "../src/server/compiler/v5/fallback";
import { canonicalConditions, GOLDEN } from "../src/server/compiler/v5/goldenSet";
import { ollamaFor } from "../src/server/compiler/callModel";

const models = process.argv.slice(2);
if (models.length === 0) { console.error("usage: eval-compiler-model.ts <ollama model> [...]"); process.exit(2); }
const threshold = process.env.EVAL_THRESHOLD ? Number(process.env.EVAL_THRESHOLD) : null;
const outDir = path.join(process.cwd(), "results", "compiler-eval");
mkdirSync(outDir, { recursive: true });

async function main() {
let failed = false;
for (const model of models) {
  const rows: any[] = [];
  let modelCalls = 0;
  const t0 = Date.now();
  for (const g of GOLDEN) {
    const start = Date.now();
    try {
      const d = await compileProgram(g.text, {
        disabledRecognisers: new Set(["universe+mcap", "indicators", "patterns"]),
        resolve: false,   // score what the model READ; defaults (RSI 14, VStop close) are filled in afterwards by resolveProgram
        fallback: makeClauseFallback(ollamaFor(model)),
      });
      modelCalls += d.modelCalls;
      const got = canonicalConditions(d.program);
      const pass = JSON.stringify(got) === JSON.stringify(g.conditions);
      rows.push({ id: g.id, pass, expected: g.conditions, got, not_understood: d.program.unrecognised.length, ms: Date.now() - start });
    } catch (e) {
      rows.push({ id: g.id, pass: false, error: (e as Error).message, ms: Date.now() - start });
    }
    process.stdout.write(rows.at(-1).pass ? "." : "x");
  }
  const passed = rows.filter((r) => r.pass).length;
  const rate = passed / rows.length;
  const report = { model, run_at: new Date().toISOString(), cases: rows.length, passed, pass_rate: rate, model_calls: modelCalls, seconds: Math.round((Date.now() - t0) / 1000), threshold, rows };
  writeFileSync(path.join(outDir, `${model.replace(/[^\w.-]+/g, "_")}.json`), JSON.stringify(report, null, 1));
  console.log(`\n${model}: ${passed}/${rows.length} (${(rate * 100).toFixed(1)}%) in ${report.seconds}s, ${modelCalls} model calls`);
  if (threshold !== null && rate < threshold) { failed = true; console.log(`  below threshold ${threshold}`); }
}
process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
