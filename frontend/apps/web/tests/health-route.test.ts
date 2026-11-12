import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { recordModelCheck, resetModelCheck } from "@/server/health";
import type { Db } from "@/server/db/pg";

let raw: Db;
vi.mock("@/server/db/client", () => ({ db: () => raw }));
const getHealth = vi.fn();
vi.mock("@/server/engine/client", async (orig) => ({ ...(await orig<typeof import("@/server/engine/client")>()), getHealth: (...a: unknown[]) => getHealth(...a) }));
import { GET } from "@/../app/api/health/route";

beforeEach(async () => { raw = await createTestDb(); resetModelCheck(); getHealth.mockReset(); });
const deep = () => GET(new Request("http://x/api/health?deep=1"));

describe("GET /api/health", () => {
  it("without ?deep stays the engine's own /health (the browser reads last_bar_date from it)", async () => {
    getHealth.mockResolvedValue({ status: "ok", last_bar_date: "2026-10-23" });
    const res = await GET(new Request("http://x/api/health"));
    expect(await res.json()).toEqual({ status: "ok", last_bar_date: "2026-10-23" });
  });

  it("?deep=1 reports database, engine and model together, 200 when the app can serve", async () => {
    getHealth.mockResolvedValue({ status: "ok", last_bar_date: "2026-10-23", warm: { state: "ready" } });
    recordModelCheck({ state: "ok" });
    const res = await deep();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: { ok: true }, engine: { ok: true, warm: "ready" }, model: { state: "ok" } });
  });

  it("?deep=1 is 503 when the engine is unreachable, and says so without the raw error", async () => {
    getHealth.mockRejectedValue(new Error("connect ECONNREFUSED 10.1.2.3:8080"));
    const res = await deep();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.engine).toEqual({ ok: false, error: "engine unreachable" });
    expect(JSON.stringify(body)).not.toMatch(/10\.1\.2\.3/);
  });

  it("?deep=1 is 503 when the database is not ready", async () => {
    getHealth.mockResolvedValue({ status: "ok" });
    await raw.run("SET search_path = public");
    expect((await deep()).status).toBe(503);
  });
});
