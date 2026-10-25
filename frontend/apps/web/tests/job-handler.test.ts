import { describe, expect, it, vi } from "vitest";
import { handleJobRequest } from "@/server/jobHandler";

const req = (body: unknown, secret?: string) => new Request("http://x/.netlify/functions/draft-job-background", {
  method: "POST", headers: { "content-type": "application/json", ...(secret ? { "x-job-secret": secret } : {}) }, body: typeof body === "string" ? body : JSON.stringify(body),
});
const env = (over: Record<string, string> = {}) => ({ JOB_SECRET: "job-secret", ...over }) as unknown as NodeJS.ProcessEnv;

describe("handleJobRequest (the Netlify background function's entry point)", () => {
  it("refuses a caller without the shared secret, and a server with no secret configured", async () => {
    const run = vi.fn();
    expect((await handleJobRequest(req({ jobId: 1 }), { run, env: env() })).status).toBe(403);
    expect((await handleJobRequest(req({ jobId: 1 }, "wrong"), { run, env: env() })).status).toBe(403);
    expect((await handleJobRequest(req({ jobId: 1 }, "job-secret"), { run, env: env({ JOB_SECRET: "" }) })).status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects a body that is not {jobId: integer}", async () => {
    const run = vi.fn();
    for (const body of ["nope", {}, { jobId: "1" }, { jobId: 1.5 }]) expect((await handleJobRequest(req(body, "job-secret"), { run, env: env() })).status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it("runs the job and answers 202", async () => {
    const run = vi.fn(async () => {});
    const res = await handleJobRequest(req({ jobId: 42 }, "job-secret"), { run, env: env() });
    expect(res.status).toBe(202);
    expect(run).toHaveBeenCalledWith(42);
  });

  it("a job that throws is still a 202: its failure is recorded on the job row, not in the trigger's response", async () => {
    const res = await handleJobRequest(req({ jobId: 1 }, "job-secret"), { run: vi.fn(async () => { throw new Error("boom"); }), env: env() });
    expect(res.status).toBe(202);
  });
});
