import type { Db } from "@/server/db/pg";
import { task } from "@/server/telemetry";

export async function withJob<T>(
  raw: Db,
  key: { type: string; promptId: number; asOf: string | null },
  fn: () => Promise<T>,
  // Optional: a job whose fn succeeds but whose work isn't finished yet (e.g.
  // validate_prior on a run whose later horizons haven't matured) returns
  // false here — the row goes back to 'queued' instead of 'done', so the next
  // call for the same key runs fn again rather than skipping it.
  opts: { isComplete?: (result: T) => boolean } = {}
): Promise<{ result: T | null; skipped: boolean }> {
  const existing = await raw.get<{ job_id: number; status: string; attempts: number }>(
    key.asOf === null
      ? "SELECT job_id, status, attempts FROM jobs WHERE type = ? AND prompt_id = ? AND as_of IS NULL"
      : "SELECT job_id, status, attempts FROM jobs WHERE type = ? AND prompt_id = ? AND as_of = ?",
    key.asOf === null ? [key.type, key.promptId] : [key.type, key.promptId, key.asOf]);

  if (existing && existing.status === "done") {
    return { result: null, skipped: true };
  }

  const now = new Date().toISOString();
  let jobId: number;
  let attempts: number;
  if (existing) {
    jobId = existing.job_id;
    attempts = existing.attempts;
    await raw.run("UPDATE jobs SET status = 'running' WHERE job_id = ?", [jobId]);
  } else {
    jobId = (await raw.get<{ job_id: number }>(
      "INSERT INTO jobs (type, prompt_id, as_of, status, attempts, created_at) VALUES (?, ?, ?, 'running', 0, ?) RETURNING job_id",
      [key.type, key.promptId, key.asOf, now]))!.job_id;
    attempts = 0;
  }

  try {
    // observability: every job (catch_up, validate_prior, ...) is a task in the run's trace; a no-op unless telemetry is installed
    const result = await task(`job.${key.type}`, fn, { argsOf: () => ({ prompt_id: key.promptId, as_of: key.asOf }), captureOutput: false })();
    const status = opts.isComplete && !opts.isComplete(result) ? "queued" : "done";
    await raw.run("UPDATE jobs SET status = ?, attempts = ?, error = NULL, finished_at = ? WHERE job_id = ?", [status, attempts + 1, new Date().toISOString(), jobId]);
    return { result, skipped: false };
  } catch (err) {
    await raw.run("UPDATE jobs SET status = 'failed', attempts = ?, error = ?, finished_at = ? WHERE job_id = ?", [
      attempts + 1, (err as Error).message, new Date().toISOString(), jobId,
    ]);
    throw err;
  }
}
