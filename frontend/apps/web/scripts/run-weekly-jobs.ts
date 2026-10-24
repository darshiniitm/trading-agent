import { db } from "@/server/db/client";
import { runCatchUp } from "@/server/catchUp";
import { computeAllWatchlistMetrics } from "@/server/viewData";
import { initTelemetry } from "@/server/telemetry/bootstrap";
import { inJobRun } from "@/server/telemetry/run";

async function main() {
  const telemetry = initTelemetry();   // no-op unless OTEL_EXPORTER_OTLP_ENDPOINT / TELEMETRY_DB_URL / SUPABASE_DB_URL is set
  const raw = db();
  const prompts = raw.prepare("SELECT prompt_id, title FROM prompts WHERE status = 'confirmed'").all() as { prompt_id: number; title: string }[];

  for (const prompt of prompts) {
    try {
      const { weeksRun, gradingFailures, armRegistrationError } = await inJobRun({ name: "catch_up", promptId: prompt.prompt_id }, () => runCatchUp(raw, { promptId: prompt.prompt_id }));
      if (armRegistrationError) {
        console.warn(`Prompt ${prompt.prompt_id} (${prompt.title}): arm registration failed (will retry next catch-up) — ${armRegistrationError}`);
      }
      console.log(
        weeksRun.length > 0
          ? `Prompt ${prompt.prompt_id} (${prompt.title}): caught up ${weeksRun.join(", ")}`
          : `Prompt ${prompt.prompt_id} (${prompt.title}): up to date`
      );
      for (const failure of gradingFailures) {
        console.warn(`Prompt ${prompt.prompt_id} (${prompt.title}): grading failed for run ${failure} (will retry next catch-up)`);
      }
    } catch (err) {
      console.error(`Prompt ${prompt.prompt_id} (${prompt.title}): FAILED — ${(err as Error).message}`);
    }
  }

  // P6 watchlist views: chained after the screen run (no separate schedule) so new picks get metrics immediately.
  // Display only and non-fatal — a failure here never affects the recorded screen/grade results above.
  try {
    const { symbols, failed } = await computeAllWatchlistMetrics(raw);
    console.log(`Watchlist view metrics: ${symbols} symbols${Object.keys(failed).length ? `, ${Object.keys(failed).length} failed (${Object.keys(failed).join(", ")})` : ""}`);
  } catch (err) {
    console.warn(`Watchlist view metrics skipped — ${(err as Error).message}`);
  }

  await telemetry.shutdown();   // flush spans / metrics / run rows before this short-lived process exits
}

main();
