// Netlify background function (the "-background" suffix gives it a 15-minute limit): runs one queued draft job.
// Bundled to ../../netlify/functions/draft-job-background.mjs by scripts/build-background.mjs (path aliases and the `spec`
// workspace package are resolved at bundle time). See docs/netlify-production-plan.md §6.2.
import { db } from "@/server/db/client";
import { handleJobRequest } from "@/server/jobHandler";
import { runDraftJob } from "@/server/jobQueue";
import { flushTelemetryBounded } from "@/server/telemetry/flush";

export default async function handler(req: Request): Promise<Response> {
  try { return await handleJobRequest(req, { run: (jobId) => runDraftJob(db(), jobId) }); }
  finally { await flushTelemetryBounded(undefined, undefined, 5000); }
}
