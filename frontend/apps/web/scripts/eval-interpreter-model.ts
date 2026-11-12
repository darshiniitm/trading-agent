// P5 (plan §7, §8): compare models for the Reader (and the model Critic) on the interpreter golden set.
// Only the cases the tools cannot read are sent to the model — those are what the Reader is for.
//   npx tsx scripts/eval-interpreter-model.ts gemma4:latest mistral:latest
// EVAL_THRESHOLD=0.8 -> exit 1 if a model's full-case pass rate is below it (your threshold to set).
// Writes results/interpreter-eval/<model>.json with pass rate, per-slot accuracy, calls, dropped mentions.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { interpret } from "../src/server/compiler/v5/interpret";
import { makeReader } from "../src/server/compiler/v5/reader";
import { makeModelCritic } from "../src/server/compiler/v5/critic";
import { casePasses, GOLDEN_INTERPRETER, slotMatches, slotReport, type SlotName } from "../src/server/compiler/v5/goldenInterpreter";
import { ollamaFor } from "../src/server/compiler/callModel";
import { loadLlmConfig } from "../src/server/llm/config";
import { pushGauge } from "../src/server/telemetry/gauges";

const models = process.argv.slice(2);
if (models.length === 0) { console.error("usage: eval-interpreter-model.ts <ollama model> [...]"); process.exit(2); }
const threshold = process.env.EVAL_THRESHOLD ? Number(process.env.EVAL_THRESHOLD) : null;
const outDir = path.join(process.cwd(), "results", "interpreter-eval");
mkdirSync(outDir, { recursive: true });
const cases = GOLDEN_INTERPRETER.filter((c) => c.needsModel);

async function main() {
  let failed = false;
  for (const model of models) {
    const call = ollamaFor(model);
    const rows: any[] = [];
    let calls = 0, dropped = 0;
    const t0 = Date.now();
    for (const c of cases) {
      const start = Date.now();
      try {
        const r = await interpret(c.text, { reader: makeReader(call), critic: makeModelCritic(call) });
        calls += r.reader.calls; dropped += r.reader.dropped.length;
        const m = slotMatches(r.program, c.expected);
        rows.push({ id: c.id, pass: casePasses(m), slots: m, rounds: r.rounds, issues: r.issues.length, dropped: r.reader.dropped, ms: Date.now() - start });
      } catch (e) { rows.push({ id: c.id, pass: false, error: (e as Error).message, slots: null, ms: Date.now() - start }); }
      process.stdout.write(rows.at(-1).pass ? "." : "x");
    }
    const ok = rows.filter((r) => r.slots);
    const rate = rows.filter((r) => r.pass).length / rows.length;
    const report = { model, run_at: new Date().toISOString(), cases: rows.length, passed: rows.filter((r) => r.pass).length, pass_rate: rate,
      slot_accuracy: slotReport(ok.map((r) => r.slots) as Record<SlotName, boolean>[]), reader_calls: calls, dropped_mentions: dropped,
      seconds: Math.round((Date.now() - t0) / 1000), threshold, rows };
    writeFileSync(path.join(outDir, `${model.replace(/[^\w.-]+/g, "_")}.json`), JSON.stringify(report, null, 1));
    // Observability: golden_suite_accuracy{provider,model,suite_version}; OTLP; no-op without OTEL_EXPORTER_OTLP_ENDPOINT
    const provider = loadLlmConfig().provider, suite = "interpreter-golden-needs-model-v1";
    await pushGauge({ name: "golden_suite_accuracy", labels: { provider, model, suite_version: suite }, value: rate });
    console.log(`\n${model}: ${report.passed}/${rows.length} (${(rate * 100).toFixed(0)}%) in ${report.seconds}s, ${calls} reader calls, ${dropped} dropped`);
    console.log("  slots:", Object.entries(report.slot_accuracy).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join("  "));
    if (threshold !== null && rate < threshold) { failed = true; console.log(`  below threshold ${threshold}`); }
  }
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
