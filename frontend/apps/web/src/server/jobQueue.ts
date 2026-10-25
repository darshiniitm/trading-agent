import type { Db } from "@/server/db/pg";
import { compileProgramDraft, screenProgramDraft } from "@/server/compileProgramDraft";
import { EngineError } from "@/server/engine/client";
import { engineErrorResponse } from "@/server/engine/respond";

// Draft-level background jobs (docs/netlify-production-plan.md §6.2). A Netlify function is cut off at 60 s; compile and screen
// can take longer when the LLM is slow. In LONG_REQUESTS=background mode the route writes a job row, a background function
// (15 min) runs it, and the page polls GET /api/jobs/:id. The same single pipeline runs — no retry loops or voting (17 Oct rule).

export type JobType = "compile" | "screen";
export type JobExecutors = {
  compile: (raw: Db, draftId: number, payload: Record<string, unknown>) => Promise<unknown>;
  screen: (raw: Db, draftId: number, payload: Record<string, unknown>) => Promise<unknown>;
};
export type JobView = { status: "queued" | "running" } | { status: "done" | "failed"; httpStatus: number; body: unknown };

export const longRequestMode = (env: NodeJS.ProcessEnv = process.env): "sync" | "background" =>
  env.LONG_REQUESTS === "background" ? "background" : "sync";

// A background function may run 15 minutes; the model gets slightly less so the job can still record its answer.
const BACKGROUND_DEADLINE_MS = 13 * 60_000;
const STUCK_RUNNING_MS = 16 * 60_000;    // past the function limit: the run died without recording a result
const STUCK_QUEUED_MS = 10 * 60_000;     // the trigger never reached the function

export const defaultExecutors: JobExecutors = {
  compile: (raw, draftId, p) => compileProgramDraft(raw, draftId, { deadlineMs: BACKGROUND_DEADLINE_MS, ...(p.useModel === false ? { useModel: false } : {}) }),
  screen: (raw, draftId, p) => screenProgramDraft(raw, draftId, String(p.as_of), undefined, p.table === true),
};

export async function enqueueDraftJob(raw: Db, j: { type: JobType; draftId: number; userId: number; payload: Record<string, unknown> }): Promise<number> {
  const row = await raw.get<{ job_id: number }>(
    "INSERT INTO jobs (type, draft_id, user_id, payload, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?) RETURNING job_id",
    [j.type, j.draftId, j.userId, JSON.stringify(j.payload), new Date().toISOString()]);
  return row!.job_id;
}

/** The status and body the synchronous route would have answered with. */
async function describeFailure(err: unknown, type: JobType): Promise<{ status: number; body: unknown }> {
  if (type === "screen") {
    const down = engineErrorResponse(err);   // engine still loading / stopped: 503 with its state
    if (down) return { status: down.status, body: await down.json() };
    if (err instanceof EngineError) {
      // a plain-text engine failure (e.g. a 500) is shown with context, not as a bare "Internal Server Error"
      const body = typeof err.body === "string" ? { error: `The screening engine failed (${err.status}): ${err.body}. Check the engine log.` } : err.body;
      return { status: err.status, body };
    }
  }
  return { status: 400, body: { error: (err as Error).message } };
}

export async function runDraftJob(raw: Db, jobId: number, executors: JobExecutors = defaultExecutors): Promise<void> {
  // claim: only a queued job can start, so a duplicate invocation does nothing
  const job = await raw.get<{ type: JobType; draft_id: number; payload: string | null }>(
    "UPDATE jobs SET status = 'running', started_at = ?, attempts = attempts + 1 WHERE job_id = ? AND status = 'queued' AND draft_id IS NOT NULL RETURNING type, draft_id, payload",
    [new Date().toISOString(), jobId]);
  if (!job) return;
  const payload = job.payload ? (JSON.parse(job.payload) as Record<string, unknown>) : {};
  try {
    const result = await executors[job.type](raw, job.draft_id, payload);
    await raw.run("UPDATE jobs SET status = 'done', result_json = ?, error_status = NULL, finished_at = ? WHERE job_id = ?",
      [JSON.stringify(result ?? null), new Date().toISOString(), jobId]);
  } catch (err) {
    const { status, body } = await describeFailure(err, job.type);
    await raw.run("UPDATE jobs SET status = 'failed', result_json = ?, error_status = ?, error = ?, finished_at = ? WHERE job_id = ?",
      [JSON.stringify(body), status, (err as Error).message ?? String(err), new Date().toISOString(), jobId]);
  }
}

/** The caller's own job, or null: another user's job is indistinguishable from a missing one. */
export async function getJobForUser(raw: Db, jobId: number, userId: number, now = Date.now()): Promise<JobView | null> {
  const j = await raw.get<{ status: string; result_json: string | null; error_status: number | null; created_at: string; started_at: string | null }>(
    "SELECT status, result_json, error_status, created_at, started_at FROM jobs WHERE job_id = ? AND user_id = ? AND draft_id IS NOT NULL", [jobId, userId]);
  if (!j) return null;
  const stuck = (since: string | null, limit: number) => !!since && now - Date.parse(since) > limit;
  if ((j.status === "running" && stuck(j.started_at, STUCK_RUNNING_MS)) || (j.status === "queued" && stuck(j.created_at, STUCK_QUEUED_MS))) {
    return { status: "failed", httpStatus: 504, body: { error: "This request did not finish in time. Please try again." } };
  }
  if (j.status === "done") return { status: "done", httpStatus: 200, body: j.result_json ? JSON.parse(j.result_json) : null };
  if (j.status === "failed") return { status: "failed", httpStatus: j.error_status ?? 400, body: j.result_json ? JSON.parse(j.result_json) : { error: "failed" } };
  return { status: j.status === "running" ? "running" : "queued" };
}

/** Ask the Netlify background function to run the job. It answers 202 at once; the work happens there. */
export async function invokeBackgroundJob(jobId: number, env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): Promise<void> {
  const base = env.APP_URL ?? env.URL;
  if (!base || !env.JOB_SECRET) throw new Error("background jobs need APP_URL and JOB_SECRET");
  const res = await fetchFn(`${base.replace(/\/+$/, "")}/.netlify/functions/draft-job-background`, {
    method: "POST", headers: { "content-type": "application/json", "x-job-secret": env.JOB_SECRET }, body: JSON.stringify({ jobId }),
  });
  if (res.status !== 202) throw new Error(`background function answered ${res.status}`);
}

/** Route helper: queue the job and trigger its background run; if the trigger fails the job is marked failed and the error is thrown. */
export async function startBackgroundJob(raw: Db, j: { type: JobType; draftId: number; userId: number; payload: Record<string, unknown> }, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const jobId = await enqueueDraftJob(raw, j);
  try {
    await invokeBackgroundJob(jobId, env);
  } catch (err) {
    await raw.run("UPDATE jobs SET status = 'failed', error = ?, error_status = 502, result_json = ?, finished_at = ? WHERE job_id = ?",
      [(err as Error).message, JSON.stringify({ error: "could not start the background job" }), new Date().toISOString(), jobId]);
    throw err;
  }
  return jobId;
}
