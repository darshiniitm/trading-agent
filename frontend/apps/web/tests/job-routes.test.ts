import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { createDraft } from "@/server/drafts";
import { setIdentityResolver } from "@/server/auth/requireUser";
import { prep } from "./helpers/prep";
import type { Db } from "@/server/db/pg";

let raw: Db;
vi.mock("@/server/db/client", () => ({ db: () => raw }));
const compile = vi.fn(); const screenDraft = vi.fn();
vi.mock("@/server/compileProgramDraft", async (orig) => ({ ...(await orig<typeof import("@/server/compileProgramDraft")>()), compileProgramDraft: (...a: unknown[]) => compile(...a), screenProgramDraft: (...a: unknown[]) => screenDraft(...a) }));
import { POST as compileRoute } from "@/../app/api/drafts/[draftId]/program/route";
import { POST as screenRoute } from "@/../app/api/drafts/[draftId]/program/screen/route";
import { GET as jobRoute } from "@/../app/api/jobs/[jobId]/route";

const OWNER = { authUserId: "00000000-0000-4000-8000-000000000001", email: "owner@example.com", emailVerified: true, displayName: "Owner", provider: "email" };
const OTHER = { authUserId: "00000000-0000-4000-8000-000000000002", email: "other@example.com", emailVerified: true, displayName: "Other", provider: "google" };
const ctx = (draftId: number) => ({ params: { draftId: String(draftId) } });
const post = (body?: unknown) => new Request("http://x", { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
let draftId: number; let fnFetch: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  raw = await createTestDb(); const owner = await ensureOwnerUser(raw);
  ({ draftId } = await createDraft(raw, { userId: owner }));
  compile.mockReset(); screenDraft.mockReset();
  setIdentityResolver(async () => OWNER);
  vi.stubEnv("LONG_REQUESTS", "background"); vi.stubEnv("APP_URL", "https://app.example"); vi.stubEnv("JOB_SECRET", "job-secret");
  fnFetch = vi.fn(async () => new Response(null, { status: 202 }));
  vi.stubGlobal("fetch", fnFetch);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("background mode", () => {
  it("POST /program answers 202 with a job id, triggers the background function, and does not compile inline", async () => {
    const res = await compileRoute(post(), ctx(draftId));
    expect(res.status).toBe(202);
    const { jobId } = await res.json();
    expect(compile).not.toHaveBeenCalled();
    expect(await prep(raw, "SELECT type, status, draft_id FROM jobs WHERE job_id = ?").get(jobId)).toMatchObject({ type: "compile", status: "queued", draft_id: draftId });
    const [url, init] = fnFetch.mock.calls[0];
    expect(url).toBe("https://app.example/.netlify/functions/draft-job-background");
    expect(init.headers["x-job-secret"]).toBe("job-secret");
    expect(JSON.parse(init.body)).toEqual({ jobId });
  });

  it("POST /program/screen validates the body first, then queues a screen job carrying as_of and table", async () => {
    expect((await screenRoute(post({ as_of: "yesterday" }), ctx(draftId))).status).toBe(400);
    expect(await prep(raw, "SELECT count(*) AS n FROM jobs").get()).toEqual({ n: 0 });
    const res = await screenRoute(post({ as_of: "2026-10-23", table: true }), ctx(draftId));
    expect(res.status).toBe(202);
    const { jobId } = await res.json();
    expect(JSON.parse((await prep(raw, "SELECT payload FROM jobs WHERE job_id = ?").get(jobId)).payload)).toEqual({ as_of: "2026-10-23", table: true });
    expect(screenDraft).not.toHaveBeenCalled();
  });

  it("another user's draft is a 404 and queues nothing", async () => {
    setIdentityResolver(async () => OTHER);
    await raw.run("INSERT INTO signup_allowlist (email, created_at) VALUES ('other@example.com', now())");
    expect((await compileRoute(post(), ctx(draftId))).status).toBe(404);
    expect(await prep(raw, "SELECT count(*) AS n FROM jobs").get()).toEqual({ n: 0 });
  });

  it("if the background function cannot be reached the request fails now (502) and the job is marked failed", async () => {
    fnFetch.mockResolvedValue(new Response(null, { status: 500 }));
    const res = await compileRoute(post(), ctx(draftId));
    expect(res.status).toBe(502);
    expect(await prep(raw, "SELECT status FROM jobs").get()).toEqual({ status: "failed" });
  });
});

describe("sync mode (the default) is untouched", () => {
  it("compiles inline and triggers nothing", async () => {
    vi.stubEnv("LONG_REQUESTS", "");
    compile.mockResolvedValue({ ready: true });
    const res = await compileRoute(post(), ctx(draftId));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ready: true });
    expect(fnFetch).not.toHaveBeenCalled();
  });
});

describe("GET /api/jobs/:id", () => {
  const get = (id: number | string) => jobRoute(new Request("http://x"), { params: { jobId: String(id) } });

  it("returns the job's state to its owner and 404 to anyone else", async () => {
    const { jobId } = await (await compileRoute(post(), ctx(draftId))).json();
    expect(await (await get(jobId)).json()).toEqual({ status: "queued" });
    setIdentityResolver(async () => OTHER);
    await raw.run("INSERT INTO signup_allowlist (email, created_at) VALUES ('other@example.com', now())");
    expect((await get(jobId)).status).toBe(404);
  });

  it("needs sign-in, and rejects a non-numeric id", async () => {
    setIdentityResolver(async () => null);
    expect((await get(1)).status).toBe(401);
    setIdentityResolver(async () => OWNER);
    expect((await get("abc")).status).toBe(404);
  });
});
