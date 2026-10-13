// Node-only start-up work (child processes need the Node runtime; Next compiles instrumentation.ts for Edge as well,
// so this lives in its own file behind the NEXT_RUNTIME check there).
//  1. Starts the screening engine as this app's child process (it exits with the app). ENGINE_MANAGED=0 leaves that to you.
//  2. Loads the local compiler model into memory so the first user prompt does not pay the cold start
//     (~9s load + ~25s prefill for gemma4:31b). Best effort; OLLAMA_WARM=0 turns it off.
import { getSupervisor } from "@/server/engine/supervisor";

export async function startNodeServices() {
  void getSupervisor().ensureEngine();

  if (process.env.OLLAMA_WARM === "0") return;
  const { warmModel, DEFAULT_COMPILER_MODEL } = await import("@/server/compiler/callModel");
  void warmModel().then((ok) => console.log(`[compiler] ${DEFAULT_COMPILER_MODEL} ${ok ? "warmed" : "not reachable (will retry on first prompt)"}`));
}
