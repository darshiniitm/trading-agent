import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { createDraft } from "@/server/drafts";
import { EngineError } from "@/server/engine/client";
import { enqueueDraftJob, getJobForUser, longRequestMode, runDraftJob, type JobExecutors } from "@/server/jobQueue";
import { prep } from "./helpers/prep";
import type { Db } from "@/server/db/pg";

let raw: Db; let owner: number; let draftId: number;
beforeEach(async () => {
  raw = await createTestDb(); owner = await ensureOwnerUser(raw);
  ({ draftId } = await createDraft(raw, { userId: owner }));
});
const exec = (over: Partial<JobExecutors> = {}): JobExecutors => ({
  compile: vi.fn(async () => ({ ready: true })), screen: vi.fn(async () => ({ candidates: [] })), ...over,
});

describe("longRequestMode", () => {
  it("is synchronous unless LONG_REQUESTS=background", () => {
    expect(longRequestMode({} as NodeJS.ProcessEnv)).toBe("sync");
    expect(longRequestMode({ NETLIFY: "true" } as unknown as NodeJS.ProcessEnv)).toBe("sync");
    expect(longRequestMode({ LONG_REQUESTS: "background" } as unknown as NodeJS.ProcessEnv)).toBe("background");
  });
});

describe("enqueueDraftJob", () => {
  it("writes a queued job for the draft and the user", async () => {
    const id = await enqueueDraftJob(raw, { type: "compile", draftId, userId: owner, payload: { useModel: true } });
    expect(await prep(raw, "SELECT type, status, draft_id, user_id, payload FROM jobs WHERE job_id = ?").get(id))
      .toMatchObject({ type: "compile", status: "queued", draft_id: draftId, user_id: owner });
  });
});

describe("runDraftJob", () => {
  it("runs a compile job and stores its result as done", async () => {
    const id = await enqueueDraftJob(raw, { type: "compile", draftId, userId: owner, payload: {} });
    const e = exec({ compile: vi.fn(async () => ({ ready: true, normalised: "x" })) });
    await runDraftJob(raw, id, e);
    const row = await prep(raw, "SELECT status, result_json, error_status, started_at, finished_at FROM jobs WHERE job_id = ?").get(id);
    expect(row.status).toBe("done");
    expect(JSON.parse(row.result_json)).toEqual({ ready: true, normalised: "x" });
    expect(row.started_at).not.toBeNull(); expect(row.finished_at).not.toBeNull();
    expect(e.compile).toHaveBeenCalledWith(raw, draftId, expect.anything());
  });

  it("runs a screen job with its payload (as_of, table)", async () => {
    const id = await enqueueDraftJob(raw, { type: "screen", draftId, userId: owner, payload: { as_of: "2026-10-23", table: true } });
    const e = exec();
    await runDraftJob(raw, id, e);
    expect(e.screen).toHaveBeenCalledWith(raw, draftId, { as_of: "2026-10-23", table: true });
  });

  it("a plain failure is stored as failed with the same 400 body the synchronous route would send", async () => {
    const id = await enqueueDraftJob(raw, { type: "compile", draftId, userId: owner, payload: {} });
    await runDraftJob(raw, id, exec({ compile: vi.fn(async () => { throw new Error("draft has no prompt text yet"); }) }));
    const row = await prep(raw, "SELECT status, result_json, error_status, error FROM jobs WHERE job_id = ?").get(id);
    expect(row).toMatchObject({ status: "failed", error_status: 400, error: "draft has no prompt text yet" });
    expect(JSON.parse(row.result_json)).toEqual({ error: "draft has no prompt text yet" });
  });

  it("an engine error keeps its status and body (a warming engine's 503 is not a failure the page shows)", async () => {
    const id = await enqueueDraftJob(raw, { type: "screen", draftId, userId: owner, payload: { as_of: "2026-10-23" } });
    const body = { detail: { engine: { state: "warming" } } };
    await runDraftJob(raw, id, exec({ screen: vi.fn(async () => { throw new EngineError(503, body); }) }));
    const row = await prep(raw, "SELECT status, result_json, error_status FROM jobs WHERE job_id = ?").get(id);
    expect(row).toMatchObject({ status: "failed", error_status: 503 });
    expect(JSON.parse(row.result_json)).toEqual(body);
  });

  it("does nothing for a job that is not queued (a duplicate invocation must not run it twice)", async () => {
    const id = await enqueueDraftJob(raw, { type: "compile", draftId, userId: owner, payload: {} });
    const e = exec();
    await Promise.all([runDraftJob(raw, id, e), runDraftJob(raw, id, e)]);
    expect(e.compile).toHaveBeenCalledTimes(1);
    await runDraftJob(raw, id, e);
    expect(e.compile).toHaveBeenCalledTimes(1);
  });

  it("an unknown job id is a no-op", async () => {
    await expect(runDraftJob(raw, 999, exec())).resolves.toBeUndefined();
  });
});

describe("getJobForUser", () => {
  it("returns status and, once finished, the HTTP status and body", async () => {
    const id = await enqueueDraftJob(raw, { type: "compile", draftId, userId: owner, payload: {} });
    expect(await getJobForUser(raw, id, owner)).toEqual({ status: "queued" });
    await runDraftJob(raw, id, exec());
    expect(await getJobForUser(raw, id, owner)).toEqual({ status: "done", httpStatus: 200, body: { ready: true } });
  });

  it("reports a failed job with its stored status and body", async () => {
    const id = await enqueueDraftJob(raw, { type: "compile", draftId, userId: owner, payload: {} });
    await runDraftJob(raw, id, exec({ compile: vi.fn(async () => { throw new Error("nope"); }) }));
    expect(await getJobForUser(raw, id, owner)).toEqual({ status: "failed", httpStatus: 400, body: { error: "nope" } });
  });

  it("another user's job is indistinguishable from a missing one", async () => {
    const id = await enqueueDraftJob(raw, { type: "compile", draftId, userId: owner, payload: {} });
    expect(await getJobForUser(raw, id, owner + 1)).toBeNull();
    expect(await getJobForUser(raw, 999, owner)).toBeNull();
  });

  it("a job stuck running past the function limit is reported failed, not pending forever", async () => {
    const id = await enqueueDraftJob(raw, { type: "compile", draftId, userId: owner, payload: {} });
    await prep(raw, "UPDATE jobs SET status = 'running', started_at = now() - interval '20 minutes' WHERE job_id = ?").run(id);
    expect(await getJobForUser(raw, id, owner)).toMatchObject({ status: "failed", httpStatus: 504 });
  });
});
