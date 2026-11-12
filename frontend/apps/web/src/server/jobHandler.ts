import { timingSafeEqual } from "node:crypto";

// Entry point of the Netlify background function (netlify/draft-job-background.ts is a thin wrapper). Netlify answers a
// background function's caller with 202 itself and lets this keep running for up to 15 minutes; the response built here is what
// the function returns if invoked directly (tests, local runs). The secret keeps anyone but the app from starting jobs.
export async function handleJobRequest(
  req: Request,
  deps: { run: (jobId: number) => Promise<void>; env?: NodeJS.ProcessEnv },
): Promise<Response> {
  const secret = (deps.env ?? process.env).JOB_SECRET;
  const given = req.headers.get("x-job-secret") ?? "";
  const a = Buffer.from(given), b = Buffer.from(secret ?? "");
  if (!secret || a.length !== b.length || !timingSafeEqual(a, b)) return new Response("forbidden", { status: 403 });

  const body = await req.json().catch(() => null) as { jobId?: unknown } | null;
  if (!body || typeof body.jobId !== "number" || !Number.isInteger(body.jobId)) return new Response("bad request", { status: 400 });
  try { await deps.run(body.jobId); }
  catch (err) { console.error(`[draft-job] job ${body.jobId} crashed: ${(err as Error).message}`); }   // runDraftJob records failures itself; this is a crash in the harness
  return new Response(null, { status: 202 });
}
