import { initTelemetry } from "./bootstrap";

// Serverless functions are frozen the moment they respond, so batched telemetry has to be sent before the response goes out
// (docs/netlify-production-plan.md §7). Bounded, so a slow collector costs a request at most `budgetMs`, and never an error.
export async function flushTelemetryBounded(
  telemetry: { flush: () => Promise<void> } = initTelemetry(),
  env: NodeJS.ProcessEnv = process.env,
  budgetMs = 1500,
): Promise<void> {
  if (!env.NETLIFY) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      telemetry.flush().catch(() => {}),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, budgetMs); }),
    ]);
  } catch { /* telemetry never fails a request */ }
  finally { if (timer) clearTimeout(timer); }
}
