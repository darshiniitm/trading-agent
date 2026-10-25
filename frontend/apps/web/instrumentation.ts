// Runs once when the Next server starts. The real work is Node-only and lives in instrumentation.node.ts.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { startNodeServices } = await import("./instrumentation.node");
      await startNodeServices();
    } catch (err) {
      // On Netlify a throw here fails every cold start (even /api/health), so optional start-up services (telemetry,
      // model check) must not take the site down. Locally keep failing fast.
      if (!process.env.NETLIFY) throw err;
      console.error("[startup] instrumentation failed; serving without it:", err);
    }
  }
}
