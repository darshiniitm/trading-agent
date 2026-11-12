// A long request (compile, screen) may be answered `202 {jobId}` when the server runs it in a background function
// (docs/netlify-production-plan.md §6.2). This follows the job by polling and returns a Response shaped like the one the
// synchronous route would have sent, so callers' status and error handling stay exactly as they are.
type Opts = { fetchFn?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number; intervalMs?: number; maxWaitMs?: number };

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function fetchFollowingJob(url: string, init: RequestInit | undefined, o: Opts = {}): Promise<Response> {
  const fetchFn = o.fetchFn ?? fetch, sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))), now = o.now ?? Date.now;
  const res = await fetchFn(url, init);
  if (res.status !== 202) return res;
  const accepted = await res.json().catch(() => null) as { jobId?: number } | null;
  if (!accepted || typeof accepted.jobId !== "number") return reply(502, { error: "the server did not return a job id" });

  const started = now(), interval = o.intervalMs ?? 2000, maxWait = o.maxWaitMs ?? 16 * 60_000;
  let dropped = 0;
  for (;;) {
    if (now() - started > maxWait) return reply(504, { error: "This request did not finish in time. Please try again." });
    await sleep(interval);
    let poll: Response;
    try { poll = await fetchFn(`/api/jobs/${accepted.jobId}`); }
    catch {
      if (++dropped > 3) return reply(504, { error: "Lost contact with the server while waiting for the result." });
      continue;
    }
    dropped = 0;
    const view = await poll.json().catch(() => null) as { status?: string; httpStatus?: number; body?: unknown } | null;
    if (!poll.ok || !view) return reply(poll.status || 502, view ?? { error: "bad job response" });
    if (view.status === "done" || view.status === "failed") return reply(view.httpStatus ?? (view.status === "done" ? 200 : 400), view.body);
  }
}
