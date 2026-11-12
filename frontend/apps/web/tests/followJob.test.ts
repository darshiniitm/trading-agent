import { describe, expect, it, vi } from "vitest";
import { fetchFollowingJob } from "@/lib/followJob";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const noSleep = async () => {};

describe("fetchFollowingJob", () => {
  it("returns an ordinary response untouched (sync mode, errors, the warming 503)", async () => {
    const fetchFn = vi.fn(async () => json(200, { ready: true }));
    const res = await fetchFollowingJob("/api/x", { method: "POST" }, { fetchFn: fetchFn as any, sleep: noSleep });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ready: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("follows a 202 job id by polling until it is done, and answers as the original request would have", async () => {
    const polls = [{ status: "queued" }, { status: "running" }, { status: "done", httpStatus: 200, body: { candidates: [1] } }];
    const fetchFn = vi.fn(async (url: string) => (url === "/api/x" ? json(202, { jobId: 7 }) : json(200, polls.shift())));
    const res = await fetchFollowingJob("/api/x", { method: "POST" }, { fetchFn: fetchFn as any, sleep: noSleep });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ candidates: [1] });
    expect(fetchFn.mock.calls.map((c) => c[0])).toEqual(["/api/x", "/api/jobs/7", "/api/jobs/7", "/api/jobs/7"]);
  });

  it("a failed job comes back with its stored HTTP status and body, so callers' error handling is unchanged", async () => {
    const body = { detail: { engine: { state: "warming" } } };
    const fetchFn = vi.fn(async (url: string) => (url === "/api/x" ? json(202, { jobId: 3 }) : json(200, { status: "failed", httpStatus: 503, body })));
    const res = await fetchFollowingJob("/api/x", { method: "POST" }, { fetchFn: fetchFn as any, sleep: noSleep });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(body);
  });

  it("a missing job (404) ends the wait with that error", async () => {
    const fetchFn = vi.fn(async (url: string) => (url === "/api/x" ? json(202, { jobId: 3 }) : json(404, { error: "job not found" })));
    const res = await fetchFollowingJob("/api/x", {}, { fetchFn: fetchFn as any, sleep: noSleep });
    expect(res.status).toBe(404);
  });

  it("survives a few dropped polls but not an unreachable server", async () => {
    let n = 0;
    const flaky = vi.fn(async (url: string) => {
      if (url === "/api/x") return json(202, { jobId: 1 });
      if (++n <= 2) throw new TypeError("fetch failed");
      return json(200, { status: "done", httpStatus: 200, body: { ok: 1 } });
    });
    expect((await fetchFollowingJob("/api/x", {}, { fetchFn: flaky as any, sleep: noSleep })).status).toBe(200);
    const dead = vi.fn(async (url: string) => { if (url === "/api/x") return json(202, { jobId: 1 }); throw new TypeError("fetch failed"); });
    const res = await fetchFollowingJob("/api/x", {}, { fetchFn: dead as any, sleep: noSleep });
    expect(res.status).toBe(504);
  });

  it("gives up after the wait budget with a plain timeout error", async () => {
    let t = 0;
    const fetchFn = vi.fn(async (url: string) => (url === "/api/x" ? json(202, { jobId: 1 }) : json(200, { status: "running" })));
    const res = await fetchFollowingJob("/api/x", {}, { fetchFn: fetchFn as any, sleep: async () => { t += 60_000; }, now: () => t, maxWaitMs: 5 * 60_000 });
    expect(res.status).toBe(504);
    expect((await res.json()).error).toMatch(/did not finish/i);
  });
});
