import type Database from "better-sqlite3";

export async function withJob<T>(
  raw: Database.Database,
  key: { type: string; promptId: number; asOf: string | null },
  fn: () => Promise<T>
): Promise<{ result: T | null; skipped: boolean }> {
  const existing = raw
    .prepare(
      key.asOf === null
        ? "SELECT job_id, status, attempts FROM jobs WHERE type = ? AND prompt_id = ? AND as_of IS NULL"
        : "SELECT job_id, status, attempts FROM jobs WHERE type = ? AND prompt_id = ? AND as_of = ?"
    )
    .get(...(key.asOf === null ? [key.type, key.promptId] : [key.type, key.promptId, key.asOf])) as
    | { job_id: number; status: string; attempts: number }
    | undefined;

  if (existing && existing.status === "done") {
    return { result: null, skipped: true };
  }

  const now = new Date().toISOString();
  let jobId: number;
  let attempts: number;
  if (existing) {
    jobId = existing.job_id;
    attempts = existing.attempts;
    raw.prepare("UPDATE jobs SET status = 'running' WHERE job_id = ?").run(jobId);
  } else {
    const info = raw
      .prepare("INSERT INTO jobs (type, prompt_id, as_of, status, attempts, created_at) VALUES (?, ?, ?, 'running', 0, ?)")
      .run(key.type, key.promptId, key.asOf, now);
    jobId = Number(info.lastInsertRowid);
    attempts = 0;
  }

  try {
    const result = await fn();
    raw.prepare("UPDATE jobs SET status = 'done', attempts = ?, finished_at = ? WHERE job_id = ?").run(attempts + 1, new Date().toISOString(), jobId);
    return { result, skipped: false };
  } catch (err) {
    raw.prepare("UPDATE jobs SET status = 'failed', attempts = ?, error = ?, finished_at = ? WHERE job_id = ?").run(
      attempts + 1, (err as Error).message, new Date().toISOString(), jobId
    );
    throw err;
  }
}
