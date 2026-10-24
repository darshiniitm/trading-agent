// Plan A4 cutover gate: run the interpreter golden cases that need the model under local Ollama and Ollama Cloud with
// the SAME model, and decide whether production may switch to cloud.
//   OLLAMA_API_KEY=... OLLAMA_MODEL=gemma4:31b npx tsx scripts/eval-llm-parity.ts            # local then cloud
//   PARITY_PROVIDERS=cloud PARITY_LIMIT=5 npx tsx scripts/eval-llm-parity.ts                   # cloud only, first 5 cases (smoke)
// Gate (all three): cloud pass-rate >= local pass-rate · p95 end-to-end interpreter latency <= PARITY_P95_MS (5000) ·
// zero unparseable JSON outputs (counted from the LLM telemetry sink: status "bad_json", across all attempts).
// Only cases the rules cannot read are used (the rules-only golden prompts make 0 model calls — see docs/production-llm-plan.md §1.1).
// Writes results/llm-parity/<provider>.json and results/llm-parity/gate.json. The key is never printed or written.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { interpret } from "../src/server/compiler/v5/interpret";
import { makeReader } from "../src/server/compiler/v5/reader";
import { makeModelCritic } from "../src/server/compiler/v5/critic";
import { casePasses, GOLDEN_INTERPRETER, slotMatches } from "../src/server/compiler/v5/goldenInterpreter";
import { callClaude, DEFAULT_COMPILER_MODEL } from "../src/server/compiler/callModel";
import { checkModelAvailable } from "../src/server/llm/client";
import { setLlmTelemetry } from "../src/server/llm/telemetry";
import { pushGauge } from "../src/server/telemetry/gauges";

// Observability: after each provider run the pass rate is pushed as golden_suite_accuracy{provider,model,suite_version} (OTLP; no-op without OTEL_EXPORTER_OTLP_ENDPOINT).
const SUITE_VERSION = "interpreter-golden-needs-model-v1";

const providers = (process.env.PARITY_PROVIDERS ?? "local,cloud").split(",").map((s) => s.trim()).filter(Boolean) as ("local" | "cloud")[];
const limit = process.env.PARITY_LIMIT ? Number(process.env.PARITY_LIMIT) : Infinity;
const p95Max = Number(process.env.PARITY_P95_MS ?? 5000);
const cases = GOLDEN_INTERPRETER.filter((c) => c.needsModel).slice(0, limit);
const outDir = path.join(process.cwd(), "results", "llm-parity");
mkdirSync(outDir, { recursive: true });

const p95 = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] : 0; };

async function runProvider(provider: "local" | "cloud") {
  process.env.LLM_PROVIDER = provider;   // the client reads config per call
  const statuses: Record<string, number> = {};
  const gpuNs: number[] = [];
  setLlmTelemetry({
    call: (e) => { statuses[e.status] = (statuses[e.status] ?? 0) + 1; if (e.timing?.total_duration) gpuNs.push(e.timing.total_duration); },
    retry: () => {}, fallback: () => {},
  });
  if (provider === "cloud") {
    const check = await checkModelAvailable();
    if (!check.ok) throw new Error(`cloud model ${DEFAULT_COMPILER_MODEL} not available: ${check.error ?? `missing ${check.missing.join(", ")}`}`);
  }
  const rows: { id: string; pass: boolean; ms: number; slots?: object; error?: string }[] = [];
  for (const c of cases) {
    const t = Date.now();
    try {
      const r = await interpret(c.text, { reader: makeReader(callClaude), critic: makeModelCritic(callClaude) });
      const m = slotMatches(r.program, c.expected);
      rows.push({ id: c.id, pass: casePasses(m), slots: m, ms: Date.now() - t });
    } catch (e) { rows.push({ id: c.id, pass: false, ms: Date.now() - t, error: (e as Error).message }); }
    process.stdout.write(rows.at(-1)!.pass ? "." : "x");
  }
  setLlmTelemetry(null);
  const report = {
    provider, model: DEFAULT_COMPILER_MODEL, run_at: new Date().toISOString(), cases: rows.length, passed: rows.filter((r) => r.pass).length,
    pass_rate: rows.length ? rows.filter((r) => r.pass).length / rows.length : 0,
    p50_ms: [...rows].map((r) => r.ms).sort((a, b) => a - b)[Math.floor(rows.length / 2)] ?? 0, p95_ms: p95(rows.map((r) => r.ms)),
    bad_json: statuses.bad_json ?? 0, call_statuses: statuses, gpu_seconds: gpuNs.reduce((a, b) => a + b, 0) / 1e9, rows,
  };
  writeFileSync(path.join(outDir, `${provider}.json`), JSON.stringify(report, null, 1));
  const pushed = await pushGauge({ name: "golden_suite_accuracy", labels: { provider, model: DEFAULT_COMPILER_MODEL, suite_version: SUITE_VERSION }, value: report.pass_rate });
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) console.log(`golden_suite_accuracy ${pushed ? "sent" : "NOT sent (collector unreachable?)"}`);
  console.log(`\n${provider}: ${report.passed}/${report.cases} pass, p95 ${report.p95_ms}ms, bad_json ${report.bad_json}, gpu ${report.gpu_seconds.toFixed(1)}s`);
  return report;
}

async function main() {
  console.log(`model ${DEFAULT_COMPILER_MODEL} · ${cases.length} model-needing golden cases · providers ${providers.join(", ")}`);
  const reports: Record<string, Awaited<ReturnType<typeof runProvider>>> = {};
  for (const p of providers) reports[p] = await runProvider(p);
  const { local, cloud } = reports;
  if (!cloud) { console.log("cloud not run: no gate decision"); return; }
  const checks = {
    accuracy_not_below_local: local ? cloud.pass_rate >= local.pass_rate : null,
    p95_within_budget: cloud.p95_ms <= p95Max,
    zero_bad_json: cloud.bad_json === 0,
  };
  const pass = Object.values(checks).every((v) => v !== false);
  writeFileSync(path.join(outDir, "gate.json"), JSON.stringify({ run_at: new Date().toISOString(), model: DEFAULT_COMPILER_MODEL, p95_budget_ms: p95Max, checks, pass, note: local ? undefined : "local not run: accuracy check skipped (null)" }, null, 1));
  console.log("A4 gate:", pass ? "PASS" : "FAIL", checks);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error((e as Error).message); process.exit(1); });
