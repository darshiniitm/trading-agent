// Runs once when the Next server starts. The real work is Node-only and lives in instrumentation.node.ts.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startNodeServices } = await import("./instrumentation.node");
    await startNodeServices();
  }
}
