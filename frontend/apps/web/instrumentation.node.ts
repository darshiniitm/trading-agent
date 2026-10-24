// Node-only start-up work (child processes need the Node runtime; Next compiles instrumentation.ts for Edge as well,
// so this lives in its own file behind the NEXT_RUNTIME check there).
//  0. Turns observability on when configured (src/server/telemetry/bootstrap.ts).
//  1. Starts the screening engine as this app's child process (it exits with the app). ENGINE_MANAGED=0 leaves that to you.
//  2. LLM_PROVIDER=cloud: fails fast if OLLAMA_MODEL is not in Ollama Cloud's /api/tags (cloud models do get retired).
//     LLM_PROVIDER=local: loads the local compiler model into memory so the first user prompt does not pay the cold start
//     (~9s load + ~25s prefill for gemma4:31b). Best effort; OLLAMA_WARM=0 turns it off.
import { getSupervisor } from "@/server/engine/supervisor";

export async function startNodeServices() {
  // Observability first, so the engine child (which inherits OTEL_* / TELEMETRY_* env) and every later call is traced.
  // A no-op unless OTEL_EXPORTER_OTLP_ENDPOINT or TELEMETRY_DB_URL / SUPABASE_DB_URL is set.
  const { initTelemetry } = await import("@/server/telemetry/bootstrap");
  const telemetry = initTelemetry();
  if (telemetry.enabled) console.log("[telemetry] enabled");

  void getSupervisor().ensureEngine();

  const { warmModel, DEFAULT_COMPILER_MODEL } = await import("@/server/compiler/callModel");
  const { checkModelAvailable } = await import("@/server/llm/client");
  const check = await checkModelAvailable({ model: DEFAULT_COMPILER_MODEL });
  if (!check.skipped) {
    if (!check.ok) throw new Error(`[compiler] Ollama Cloud model ${DEFAULT_COMPILER_MODEL} is not available${check.error ? `: ${check.error}` : ` (not in /api/tags)`}. Check OLLAMA_MODEL / OLLAMA_API_KEY.`);
    console.log(`[compiler] Ollama Cloud: ${DEFAULT_COMPILER_MODEL} available${check.missingFallbacks.length ? `; WARNING fallback models not listed: ${check.missingFallbacks.join(", ")}` : ""}`);
    return;
  }
  if (process.env.OLLAMA_WARM === "0") return;
  void warmModel().then((ok) => console.log(`[compiler] ${DEFAULT_COMPILER_MODEL} ${ok ? "warmed" : "not reachable (will retry on first prompt)"}`));
}
